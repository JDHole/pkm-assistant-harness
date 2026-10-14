"""Focused manual restart tests with a temporary Most base and fake listeners."""
import asyncio
import importlib.util
import json
import os
import socket
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import AsyncMock, patch


class RestartTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = tempfile.TemporaryDirectory()
        cls.env = patch.dict(os.environ, {"MOST_BASE_DIR": cls.base.name,
                                           "MOST_NO_TRAY": "1",
                                           "MOST_NO_SPAWN": "1",
                                           "MOST_MONITOR_PORT": "1236"})
        cls.env.start()
        source = Path(__file__).with_name("legacy").joinpath("most.py")
        spec = importlib.util.spec_from_file_location("most_restart_test_module", source)
        cls.most = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.most)

    @classmethod
    def tearDownClass(cls):
        cls.env.stop()
        for handler in cls.most.log.handlers:
            handler.close()
            cls.most.log.removeHandler(handler)
        cls.base.cleanup()

    def setUp(self):
        self.calls = []
        self.most.MANUAL_RESTART_LOCK = asyncio.Lock()

    def supervisor(self, result=True):
        async def restart(reason, manual=False):
            self.calls.append(("backend", reason, manual))
            return result
        self.most.SUP = type("FakeSupervisor", (), {"restart": staticmethod(restart)})()

    def test_stopped_monitor_launches_and_backend_is_attempted(self):
        self.supervisor()
        with patch.object(self.most, "_monitor_health", new=AsyncMock(return_value=(False, "connection_refused"))), \
             patch.object(self.most, "_launch_monitor", new=AsyncMock(return_value=(True, None))) as launch, \
             patch.object(self.most, "_verify_monitor", new=AsyncMock(return_value=(True, None))):
            result = asyncio.run(self.most.manual_restart("test"))
        self.assertTrue(result["ok"])
        self.assertTrue(result["monitor"]["ok"])
        self.assertTrue(result["backend"]["ok"])
        launch.assert_awaited_once()
        self.assertEqual("backend", self.calls[0][0])

    def test_running_monitor_is_shutdown_waited_and_relaunched(self):
        self.supervisor()
        sequence = [(True, None), (False, "connection_refused")]
        with patch.object(self.most, "_monitor_health", new=AsyncMock(side_effect=sequence)), \
             patch.object(self.most, "_shutdown_monitor", new=AsyncMock(return_value=(True, None))) as stop, \
             patch.object(self.most, "_wait_monitor_closed", new=AsyncMock(return_value=(True, None))) as wait, \
             patch.object(self.most, "_launch_monitor", new=AsyncMock(return_value=(True, None))) as launch, \
             patch.object(self.most, "_verify_monitor", new=AsyncMock(return_value=(True, None))):
            result = asyncio.run(self.most.manual_restart("test"))
        self.assertTrue(result["ok"])
        stop.assert_awaited_once()
        wait.assert_awaited_once()
        launch.assert_awaited_once()

    def test_shutdown_drain_retries_transient_timeout_until_listener_refuses(self):
        sequence = [(False, "timeout"), (False, "connection_error"),
                    (False, "connection_refused")]
        with patch.object(self.most, "_monitor_health", new=AsyncMock(side_effect=sequence)):
            result = asyncio.run(self.most._wait_monitor_closed())
        self.assertEqual((True, None), result)

    def test_concurrent_manual_clicks_are_serialized(self):
        self.supervisor()
        active = 0
        peak = 0
        async def health():
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(.02)
            active -= 1
            return False, "connection_refused"
        with patch.object(self.most, "_monitor_health", new=health), \
             patch.object(self.most, "_launch_monitor", new=AsyncMock(return_value=(True, None))) as launch, \
             patch.object(self.most, "_verify_monitor", new=AsyncMock(return_value=(True, None))):
            async def run():
                return await asyncio.gather(self.most.manual_restart("tray"),
                                            self.most.manual_restart("http"))
            results = asyncio.run(run())
        self.assertEqual(1, peak)
        self.assertEqual(2, launch.await_count)
        self.assertTrue(all(r["ok"] for r in results))

    def test_wrong_service_or_timeout_fails_closed_and_backend_still_runs(self):
        self.supervisor()
        for reason in ("wrong_service", "timeout", "http_503"):
            with self.subTest(reason=reason):
                with patch.object(self.most, "_monitor_health", new=AsyncMock(return_value=(False, reason))), \
                     patch.object(self.most, "_launch_monitor", new=AsyncMock()) as launch:
                    result = asyncio.run(self.most.manual_restart("test"))
                self.assertFalse(result["monitor"]["ok"])
                launch.assert_not_awaited()
                self.assertTrue(result["backend"]["ok"])

    def test_actual_closed_loopback_port_is_classified_as_refused(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        with patch.object(self.most, "MONITOR_PORT", port), \
             patch.object(self.most, "MONITOR_URL", f"http://127.0.0.1:{port}"):
            healthy, error = asyncio.run(self.most._monitor_health())
        self.assertFalse(healthy)
        self.assertEqual("connection_refused", error)

        class FailedRequest:
            def __init__(self, connector_error):
                self.connector_error = connector_error
            async def __aenter__(self):
                raise self.connector_error
            async def __aexit__(self, *args):
                return False

        class FailedSession:
            def __init__(self, connector_error):
                self.connector_error = connector_error
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                return False
            def request(self, *args, **kwargs):
                return FailedRequest(self.connector_error)

        for winerror, expected in ((1225, "connection_refused"), (None, "connection_error")):
            os_error = OSError(22, "synthetic Windows connector error")
            if winerror is not None:
                os_error.winerror = winerror
            connector_error = self.most.aiohttp.ClientConnectorError(None, os_error)
            with patch.object(self.most.aiohttp, "ClientSession",
                              return_value=FailedSession(connector_error)):
                _, _, classification = asyncio.run(self.most._monitor_request("/most/v1/health"))
            self.assertEqual(expected, classification)

    def test_spawn_health_and_backend_failures_are_reported(self):
        self.supervisor(False)
        with patch.object(self.most, "_monitor_health", new=AsyncMock(return_value=(False, "connection_refused"))), \
             patch.object(self.most, "_launch_monitor", new=AsyncMock(return_value=(False, "spawn_failed"))):
            result = asyncio.run(self.most.manual_restart("test"))
        self.assertFalse(result["ok"])
        self.assertEqual("spawn_failed", result["monitor"]["error"])
        self.assertFalse(result["backend"]["ok"])
        self.assertEqual(1, len(self.calls))

        self.calls.clear()
        with patch.object(self.most, "_monitor_health", new=AsyncMock(
                side_effect=[(False, "connection_refused"), (False, "connection_refused")])), \
             patch.object(self.most, "_launch_monitor", new=AsyncMock(return_value=(True, None))), \
             patch.object(self.most, "_verify_monitor", new=AsyncMock(return_value=(False, "health_timeout"))):
            result = asyncio.run(self.most.manual_restart("test"))
        self.assertFalse(result["monitor"]["ok"])
        self.assertEqual("health_timeout", result["monitor"]["error"])
        self.assertEqual(1, len(self.calls))

    def test_monitor_endpoint_guards_and_marker(self):
        from monitor import _handler
        service = type("FakeService", (), {"stop": lambda self: None})()
        http_server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(service))
        thread = threading.Thread(target=http_server.serve_forever, daemon=True)
        thread.start()
        try:
            import http.client
            def request(path, method="GET", headers=None):
                c = http.client.HTTPConnection("127.0.0.1", http_server.server_port, timeout=2)
                c.request(method, path, headers=headers or {})
                response = c.getresponse(); body = json.loads(response.read()); c.close()
                return response.status, body
            good = {"Host": f"127.0.0.1:{http_server.server_port}", "X-Most-Client": "local-v1"}
            self.assertEqual("most-monitor", request("/most/v1/health", headers=good)[1]["service"])
            self.assertEqual(403, request("/most/v1/health", headers={"X-Most-Client": "local-v1", "Origin": "x"})[0])
            self.assertEqual(403, request("/most/v1/shutdown", method="POST", headers={"X-Most-Client": "wrong"})[0])
            status, body = request("/most/v1/shutdown", method="POST", headers=good)
            self.assertEqual(202, status)
            self.assertTrue(body["ok"])
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
        finally:
            http_server.shutdown(); http_server.server_close(); thread.join(timeout=2)

    def test_service_stop_drains_http_refresh_before_listener_and_core_close(self):
        from monitor import Service, _handler
        from test_core import account
        entered = threading.Event()
        release = threading.Event()
        result = []

        def slow_collector():
            entered.set()
            if not release.wait(3):
                raise TimeoutError("test collector was not released")
            return account(20, now=__import__("time").time())

        with tempfile.TemporaryDirectory() as data_dir:
            service = Service({"dataDir": data_dir, "notifications": False,
                              "enabledProviders": ["codex"]},
                             collectors={"codex": slow_collector})
            http_server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(service))
            server_thread = threading.Thread(target=http_server.serve_forever, daemon=True)
            server_thread.start()

            def refresh_request():
                import http.client
                conn = http.client.HTTPConnection("127.0.0.1", http_server.server_port, timeout=4)
                try:
                    conn.request("POST", "/most/v1/refresh", headers={
                        "Host": f"127.0.0.1:{http_server.server_port}",
                        "X-Most-Client": "local-v1"})
                    response = conn.getresponse()
                    result.append((response.status, response.read()))
                finally:
                    conn.close()

            request_thread = threading.Thread(target=refresh_request, daemon=True)
            request_thread.start()
            self.assertTrue(entered.wait(2), "HTTP refresh did not start collector")
            try:
                self.assertFalse(service.stop(timeout=0.1), "stop must report the active refresh")
                self.assertTrue(service.stopping)
                self.assertTrue(http_server.fileno() >= 0, "listener must remain open during drain")
                self.assertEqual((1,), tuple(service.core.db.execute("SELECT 1").fetchone()),
                                 "core must remain open during drain")
                with self.assertRaises(RuntimeError):
                    service.refresh()

                release.set()
                request_thread.join(timeout=2)
                self.assertFalse(request_thread.is_alive())
                self.assertEqual(200, result[0][0])
                self.assertTrue(service.stop(timeout=2), "all refresh and delivery workers should drain")
                self.assertTrue(http_server.fileno() >= 0)
                self.assertEqual((1,), tuple(service.core.db.execute("SELECT 1").fetchone()))
            finally:
                release.set()
                request_thread.join(timeout=2)
                if service.stop(timeout=2):
                    http_server.shutdown()
                    http_server.server_close()
                    server_thread.join(timeout=2)
                    service.core.close()


if __name__ == "__main__":
    unittest.main()
