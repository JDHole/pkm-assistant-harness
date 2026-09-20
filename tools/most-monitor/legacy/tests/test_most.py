# -*- coding: utf-8 -*-
"""
Test bramkowy dla most.py (katalog wyzej). Odpala go na portach 1244/1245 z osobnym MOST_BASE_DIR - zywy most na 1234 nietkniety.
Odpala fake_backend.py (udaje ChatMocka) + most.py (bridge) jako subprocessy,
bije po HTTP i sprawdza literalne wartosci. Zero mockow - prawdziwe procesy,
prawdziwe sockety, prawdziwy plik konfiguracyjny na dysku.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
# W repo produkcyjnym testy siedza w most/tests/, kod w most/ (most.py = HERE.parent).
# W tej kopii scratchpad (most_work2) wszystko jest plasko w jednym katalogu - most.py = HERE.
MOST_PY = HERE.parent / "most.py"  # testy siedza w most/tests/, kod w most/
FAKE_BACKEND_PY = HERE / "fake_backend.py"
BASE_DIR = HERE / "base"
LAST_BODY_PATH = HERE / "last_body.json"

BRIDGE_PORT = 1244
BACKEND_PORT = 1245
BRIDGE_URL = f"http://127.0.0.1:{BRIDGE_PORT}"
BACKEND_URL = f"http://127.0.0.1:{BACKEND_PORT}"

FAILURES: list[str] = []
CREATE_NEW_PGROUP = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0


def check(label: str, cond: bool, detail: str = "") -> None:
    status = "OK" if cond else "FAIL"
    print(f"[{status}] {label}" + (f" -- {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(f"{label}: {detail}")


def http_json(method: str, url: str, payload: dict | None = None, timeout: float = 10.0):
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
        status = r.status
    try:
        parsed = json.loads(body) if body else None
    except (json.JSONDecodeError, ValueError):
        parsed = None
    return status, parsed


def http_raw(method: str, url: str, payload: dict | None = None, timeout: float = 10.0):
    """Jak http_json, ale zwraca (status, headers_dict, surowe_bajty) - bez parsowania jako JSON
    (potrzebne dla odpowiedzi SSE) i bez wyjatku na status >=400 (HTTPError zlapany i spolszczony
    na normalny wynik, tak samo jak sukces)."""
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def wait_http_ok(url: str, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            status, _ = http_json("GET", url, timeout=3.0)
            if status == 200:
                return True
        except (urllib.error.URLError, OSError, ConnectionError):
            pass
        time.sleep(0.3)
    return False


def taskkill(pid: int) -> None:
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                        capture_output=True)
    else:
        try:
            os.kill(pid, 9)
        except OSError:
            pass


def start_fake_backend(env_extra: dict | None = None) -> subprocess.Popen:
    env = dict(os.environ)
    env.pop("FAKE_MODE", None)
    env.pop("FAKE_OVERLOAD_N", None)
    if env_extra:
        env.update(env_extra)
    proc = subprocess.Popen(
        [sys.executable, str(FAKE_BACKEND_PY), str(BACKEND_PORT)],
        env=env, cwd=str(HERE),
        creationflags=CREATE_NEW_PGROUP,
    )
    return proc


def restart_fake(old_proc: subprocess.Popen, mode: str, extra: dict | None = None) -> subprocess.Popen:
    """Zabija stary fake backend i odpala nowy z innym FAKE_MODE (zerowy licznik POST-ow)."""
    taskkill(old_proc.pid)
    try:
        old_proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass
    env_extra = {"FAKE_MODE": mode}
    if extra:
        env_extra.update(extra)
    new_proc = start_fake_backend(env_extra=env_extra)
    if not wait_http_ok(f"{BACKEND_URL}/v1/models", timeout=20):
        check(f"fake backend (FAKE_MODE={mode}) wstal", False, "nie odpowiedzial na /v1/models")
    return new_proc


def main() -> int:
    if BASE_DIR.exists():
        import shutil
        shutil.rmtree(BASE_DIR, ignore_errors=True)
    BASE_DIR.mkdir(parents=True, exist_ok=True)
    LAST_BODY_PATH.unlink(missing_ok=True)

    log_path = BASE_DIR / "most" / "most.log"
    models_path = BASE_DIR / "most" / "most_models.json"
    usage_path = BASE_DIR / "usage_limits.json"

    print("--- startuje fake backend (tryb 200) ---")
    fake_proc = start_fake_backend()
    if not wait_http_ok(f"{BACKEND_URL}/v1/models", timeout=20):
        print("FAKE BACKEND NIE WSTAL - koniec")
        taskkill(fake_proc.pid)
        return 2

    print("--- startuje most (bridge) ---")
    bridge_env = dict(os.environ)
    bridge_env.update({
        "MOST_BASE_DIR": str(BASE_DIR),
        "MOST_NO_SPAWN": "1",
        "MOST_NO_TRAY": "1",
        "MOST_LISTEN_PORT": str(BRIDGE_PORT),
        "MOST_BACKEND_PORT": str(BACKEND_PORT),
        "MOST_HEALTH_INTERVAL": "2",
        "MOST_HEALTH_TICK": "1",
        "MOST_USAGE_REFRESH": "3",
        "MOST_UPSTREAM_RETRIES": "3",
        "MOST_RETRY_DELAYS": "0.2,0.2,0.2",
    })
    bridge_proc = subprocess.Popen(
        [sys.executable, str(MOST_PY)],
        env=bridge_env, cwd=str(HERE),
        creationflags=CREATE_NEW_PGROUP,
    )

    try:
        if not wait_http_ok(f"{BRIDGE_URL}/most/status", timeout=30):
            print("BRIDGE NIE WSTAL - koniec")
            FAILURES.append("bridge nie wstal w 30s")
            return 2

        # --- (a) /v1/models: 10 domyslnych id w kolejnosci + plik na dysku ---
        expected_ids = [
            "gpt-6-astra-low", "gpt-6-astra-medium", "gpt-6-astra-high", "gpt-6-astra-xhigh",
            "gpt-5.6-sol-high", "gpt-5.6-sol-xhigh", "gpt-5.6-terra-medium", "gpt-5.6-terra-high",
            "gpt-5.6-luna-medium", "gpt-5.5-low",
        ]
        status, body = http_json("GET", f"{BRIDGE_URL}/v1/models")
        ids = [m["id"] for m in body["data"]] if body else []
        check("GET /v1/models zwraca 10 domyslnych id w kolejnosci", ids == expected_ids,
              f"got={ids}")
        check("most_models.json powstal na dysku", models_path.exists(), str(models_path))

        # --- (b) rewrite modelu+effort, brak reasoning na wejsciu ---
        status, body = http_json("POST", f"{BRIDGE_URL}/v1/chat/completions", {
            "model": "gpt-6-astra-high",
            "messages": [{"role": "user", "content": "hi"}],
        })
        echo = body.get("echo") if body else None
        check("astra-high -> upstream gpt-6-astra", bool(echo) and echo.get("model") == "gpt-6-astra",
              f"echo={echo}")
        check("astra-high -> reasoning={'effort':'high'}", bool(echo) and echo.get("reasoning") == {"effort": "high"},
              f"echo={echo}")

        # --- (c) rewrite zachowuje istniejacy klucz summary ---
        status, body = http_json("POST", f"{BRIDGE_URL}/v1/chat/completions", {
            "model": "gpt-6-astra-high",
            "messages": [{"role": "user", "content": "hi"}],
            "reasoning": {"summary": "detailed"},
        })
        echo = body.get("echo") if body else None
        check("summary zachowany obok effort", bool(echo) and echo.get("reasoning") == {"summary": "detailed", "effort": "high"},
              f"echo={echo}")

        # --- (d) nieznana nazwa modelu -> passthrough bez zmian ---
        sent = {"model": "foo-bar", "messages": [{"role": "user", "content": "hi"}]}
        status, body = http_json("POST", f"{BRIDGE_URL}/v1/chat/completions", sent)
        echo = body.get("echo") if body else None
        check("foo-bar: model niezmieniony", bool(echo) and echo.get("model") == "foo-bar", f"echo={echo}")
        check("foo-bar: brak klucza reasoning", bool(echo) and "reasoning" not in echo, f"echo={echo}")
        check("foo-bar: body identyczny 1:1", echo == sent, f"sent={sent} echo={echo}")

        # --- (e) eco mode ---
        status, body = http_json("POST", f"{BRIDGE_URL}/most/eco", {"on": True})
        check("/most/eco {on:true} zwraca eco_mode=true", body == {"eco_mode": True}, f"body={body}")

        status, body = http_json("POST", f"{BRIDGE_URL}/v1/chat/completions", {
            "model": "gpt-6-astra-medium",
            "messages": [{"role": "user", "content": "hi"}],
        })
        echo = body.get("echo") if body else None
        check("eco: astra-medium -> upstream gpt-5.6-sol", bool(echo) and echo.get("model") == "gpt-5.6-sol",
              f"echo={echo}")
        check("eco: astra-medium -> effort xhigh", bool(echo) and echo.get("reasoning") == {"effort": "xhigh"},
              f"echo={echo}")

        status, body = http_json("GET", f"{BRIDGE_URL}/most/status")
        check("/most/status usage.eco_mode == true", bool(body) and body["usage"]["eco_mode"] is True,
              f"usage={body.get('usage') if body else None}")

        try:
            on_disk = json.loads(models_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            on_disk = None
            check("most_models.json czytelny po zmianie eco", False, str(e))
        else:
            check("most_models.json: eco_mode=true na dysku", on_disk.get("eco_mode") is True, f"on_disk={on_disk}")
            check("most_models.json: nadal 10 modeli", len(on_disk.get("models", [])) == 10,
                  f"count={len(on_disk.get('models', []))}")

        # --- (f) usage_limits.json - dwa okna ---
        now_iso = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
        usage_payload = {
            "captured_at": now_iso,
            "primary": {"used_percent": 8.0, "window_minutes": 300, "resets_in_seconds": 15898},
            "secondary": {"used_percent": 1.0, "window_minutes": 10080, "resets_in_seconds": 289753},
        }
        usage_path.write_text(json.dumps(usage_payload), encoding="utf-8")

        status, body = http_json("GET", f"{BRIDGE_URL}/most/status")
        usage = body.get("usage") if body else None
        check("usage.short_used_percent == 8.0", bool(usage) and usage.get("short_used_percent") == 8.0,
              f"usage={usage}")
        check("usage.short_window_minutes == 300", bool(usage) and usage.get("short_window_minutes") == 300,
              f"usage={usage}")
        check("usage.weekly_used_percent == 1.0", bool(usage) and usage.get("weekly_used_percent") == 1.0,
              f"usage={usage}")

        # --- (g) health: 400 z backendu na /v1/chat/completions NIE restartuje ---
        print("--- restart fake backend w FAKE_MODE=400 ---")
        taskkill(fake_proc.pid)
        fake_proc.wait(timeout=10)
        fake_proc = start_fake_backend(env_extra={"FAKE_MODE": "400"})
        if not wait_http_ok(f"{BACKEND_URL}/v1/models", timeout=20):
            check("fake backend (400 mode) wstal", False, "nie odpowiedzial na /v1/models")
        print("--- czekam ~8s bez ruchu (petla zdrowia powinna nie zrobic restartu) ---")
        time.sleep(8)

        log_text = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        check("brak linii RESTART w logu po samym 400 z /v1/chat/completions", "RESTART" not in log_text)
        check("monitor zastapil automatyczny mikro-ping", "mikro-ping" not in log_text)

        status, body = http_json("GET", f"{BRIDGE_URL}/most/status")
        check("/most/status state nadal 'ok' po 400-kach", bool(body) and body.get("state") == "ok",
              f"body={body}")

        # --- (h) health: martwy backend -> restart ---
        print("--- zabijam fake backend calkowicie ---")
        taskkill(fake_proc.pid)
        try:
            fake_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        print("--- czekam ~8s (petla zdrowia powinna wykryc padniecie i zalogowac restart) ---")
        time.sleep(8)

        log_text = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        check("log zawiera 'RESTART backendu, powod: backend nie odpowiada'",
              "RESTART backendu, powod: backend nie odpowiada" in log_text)

        # --- (i) retry na przejsciowa awarie upstreamu (punkt 7 kontraktu) ---
        #
        # Petla zdrowia mostu ma wlasny mikro-ping (MOST_USAGE_REFRESH=3s w tym env) ktory
        # bije w BACKEND_URL bezposrednio (mija _pump), z tym samym modelem co nasze testy -
        # w trybie overload_n zjadalby jeden ze "slotow" fake'a i myliby liczniki. Trzymamy
        # usage_limits.json swiezy (age_s ~ 0) w oknie kazdego pod-testu, zeby _usage_needs_refresh()
        # zostalo False i ping sie nie odpalil w trakcie pomiaru.

        def keep_usage_fresh() -> None:
            now_iso = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
            usage_payload = {
                "captured_at": now_iso,
                "primary": {"used_percent": 8.0, "window_minutes": 300, "resets_in_seconds": 15898},
                "secondary": {"used_percent": 1.0, "window_minutes": 10080, "resets_in_seconds": 289753},
            }
            usage_path.write_text(json.dumps(usage_payload), encoding="utf-8")

        def status_counters() -> tuple[int | None, int | None]:
            _, body = http_json("GET", f"{BRIDGE_URL}/most/status")
            if not body:
                return None, None
            return body.get("retries_total"), body.get("retry_rescued_total")

        def log_tail() -> str:
            return log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""

        def fake_post_count() -> dict | None:
            _, body = http_json("GET", f"{BACKEND_URL}/fake/count")
            return body

        # (i1) overload_n=2, streaming: 2 probe padaja, 3. ratuje - klient widzi tylko sukces
        print("--- (i1) FAKE_MODE=overload_n (2), request streaming ---")
        keep_usage_fresh()
        fake_proc = restart_fake(fake_proc, "overload_n", {"FAKE_OVERLOAD_N": "2"})
        keep_usage_fresh()
        retries_before, rescued_before = status_counters()
        log_before = log_tail()

        status, headers, raw = http_raw("POST", f"{BRIDGE_URL}/v1/chat/completions", {
            "model": "gpt-5.5-low",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        }, timeout=15.0)
        text = raw.decode("utf-8", errors="replace")
        check("i1 overload_n stream: HTTP 200 (klient nie widzi przejsciowej awarii)", status == 200,
              f"status={status}")
        check("i1 overload_n stream: body zawiera [DONE]", "[DONE]" in text, f"body={text!r}")
        check("i1 overload_n stream: brak \"error\" w body", '"error"' not in text, f"body={text!r}")

        check("i1 overload_n stream: fake naliczyl 3 POSTy", fake_post_count() == {"posts": 3},
              f"count={fake_post_count()}")

        retries_after, rescued_after = status_counters()
        check("i1 overload_n stream: retries_total += 2", retries_after - retries_before == 2,
              f"before={retries_before} after={retries_after}")
        check("i1 overload_n stream: retry_rescued_total += 1", rescued_after - rescued_before == 1,
              f"before={rescued_before} after={rescued_after}")

        diff_log = log_tail()[len(log_before):]
        check("i1 overload_n stream: 2 linie 'UPSTREAM pad (proba' w logu", diff_log.count("UPSTREAM pad (proba") == 2,
              f"diff={diff_log!r}")
        check("i1 overload_n stream: 1 linia 'UPSTREAM uratowany po 2 ponowieniach'",
              "UPSTREAM uratowany po 2 ponowieniach" in diff_log, f"diff={diff_log!r}")

        # (i2) overload_n=2, non-streaming: te same oczekiwania, echo JSON zamiast SSE
        print("--- (i2) FAKE_MODE=overload_n (2), request non-streaming ---")
        keep_usage_fresh()
        fake_proc = restart_fake(fake_proc, "overload_n", {"FAKE_OVERLOAD_N": "2"})
        keep_usage_fresh()
        retries_before, rescued_before = status_counters()
        log_before = log_tail()

        status, body = http_json("POST", f"{BRIDGE_URL}/v1/chat/completions", {
            "model": "gpt-5.5-low",
            "messages": [{"role": "user", "content": "hi"}],
        }, timeout=15.0)
        echo = body.get("echo") if body else None
        check("i2 overload_n non-stream: HTTP 200", status == 200, f"status={status}")
        check("i2 overload_n non-stream: JSON echo, model gpt-5.5", bool(echo) and echo.get("model") == "gpt-5.5",
              f"echo={echo}")

        check("i2 overload_n non-stream: fake naliczyl 3 POSTy", fake_post_count() == {"posts": 3},
              f"count={fake_post_count()}")

        retries_after, rescued_after = status_counters()
        check("i2 overload_n non-stream: retries_total += 2", retries_after - retries_before == 2,
              f"before={retries_before} after={retries_after}")
        check("i2 overload_n non-stream: retry_rescued_total += 1", rescued_after - rescued_before == 1,
              f"before={rescued_before} after={rescued_after}")

        diff_log = log_tail()[len(log_before):]
        check("i2 overload_n non-stream: 2 linie 'UPSTREAM pad (proba' w logu", diff_log.count("UPSTREAM pad (proba") == 2,
              f"diff={diff_log!r}")
        check("i2 overload_n non-stream: 1 linia 'UPSTREAM uratowany po 2 ponowieniach'",
              "UPSTREAM uratowany po 2 ponowieniach" in diff_log, f"diff={diff_log!r}")

        # (i3) overload_always: wyczerpuje wszystkie proby -> 429 glosne dla klienta
        print("--- (i3) FAKE_MODE=overload_always ---")
        keep_usage_fresh()
        fake_proc = restart_fake(fake_proc, "overload_always")
        keep_usage_fresh()
        retries_before, _ = status_counters()

        status, headers, raw = http_raw("POST", f"{BRIDGE_URL}/v1/chat/completions", {
            "model": "gpt-5.5-low",
            "messages": [{"role": "user", "content": "hi"}],
        }, timeout=15.0)
        check("i3 overload_always: HTTP 429", status == 429, f"status={status}")
        check("i3 overload_always: header Retry-After: 30", headers.get("Retry-After") == "30",
              f"headers={headers}")
        try:
            err_body = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            err_body = None
        msg = (err_body or {}).get("error", {}).get("message")
        check("i3 overload_always: message zaczyna sie od 'Most: backend OpenAI przeciazony (4 prob)'",
              bool(msg) and msg.startswith("Most: backend OpenAI przeciazony (4 prob)"), f"msg={msg}")

        check("i3 overload_always: fake naliczyl 4 POSTy", fake_post_count() == {"posts": 4},
              f"count={fake_post_count()}")

        retries_after, _ = status_counters()
        check("i3 overload_always: retries_total += 3", retries_after - retries_before == 3,
              f"before={retries_before} after={retries_after}")

        # (i4) http503: sciezka transient_status (bez zadnego chunku do sparsowania)
        print("--- (i4) FAKE_MODE=http503 ---")
        keep_usage_fresh()
        fake_proc = restart_fake(fake_proc, "http503")
        keep_usage_fresh()

        status, headers, raw = http_raw("POST", f"{BRIDGE_URL}/v1/chat/completions", {
            "model": "gpt-5.5-low",
            "messages": [{"role": "user", "content": "hi"}],
        }, timeout=15.0)
        check("i4 http503: HTTP 429 (transient_status)", status == 429, f"status={status}")
        check("i4 http503: header Retry-After: 30", headers.get("Retry-After") == "30", f"headers={headers}")

        check("i4 http503: fake naliczyl 4 POSTy", fake_post_count() == {"posts": 4},
              f"count={fake_post_count()}")

        # (i5) bad_model: error-chunk NIE-przejsciowy -> passthrough bajt-w-bajt, bez retry
        print("--- (i5) FAKE_MODE=bad_model ---")
        keep_usage_fresh()
        fake_proc = restart_fake(fake_proc, "bad_model")
        keep_usage_fresh()
        log_before = log_tail()

        status, headers, raw = http_raw("POST", f"{BRIDGE_URL}/v1/chat/completions", {
            "model": "gpt-5.5-low",
            "messages": [{"role": "user", "content": "hi"}],
        }, timeout=15.0)
        expected_bad_model_body = b'data: {"error": {"message": "Invalid model: nope"}}\n\ndata: [DONE]\n\n'
        check("i5 bad_model: HTTP 200 (blad nietransientowy przechodzi bez zmian)", status == 200,
              f"status={status}")
        check("i5 bad_model: body identyczny bajt-w-bajt z fake", raw == expected_bad_model_body,
              f"raw={raw!r}")

        check("i5 bad_model: fake naliczyl 1 POST (brak retry)", fake_post_count() == {"posts": 1},
              f"count={fake_post_count()}")

        diff_log = log_tail()[len(log_before):]
        check("i5 bad_model: brak linii 'UPSTREAM pad (proba' w logu", "UPSTREAM pad (proba" not in diff_log,
              f"diff={diff_log!r}")

    finally:
        print("--- sprzatanie procesow ---")
        taskkill(bridge_proc.pid)
        try:
            taskkill(fake_proc.pid)
        except Exception:
            pass

    print()
    if FAILURES:
        print(f"=== {len(FAILURES)} ASERCJA(E) NIE PRZESZLY ===")
        for f in FAILURES:
            print(" -", f)
        return 1
    print("=== WSZYSTKIE ASERCJE PRZESZLY ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
