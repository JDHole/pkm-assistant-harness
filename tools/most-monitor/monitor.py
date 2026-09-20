"""Local HTTP daemon and CLI for Most Monitor."""
from __future__ import annotations
import argparse, concurrent.futures, importlib.util, json, random, sys, threading, time, hashlib, secrets
import logging
from logging.handlers import RotatingFileHandler
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from core import MonitorCore

class Service:
    def __init__(self, config, collectors=None, notifier=None):
        self.config = config
        if notifier is None and config.get("notifications", True):
            try:
                import notifier as notifier_module
                notifier = notifier_module
            except ImportError:
                notifier = None
        self.core = MonitorCore(config["dataDir"], host_id=config.get('hostId'), notifier=notifier, snapshot_path=config.get('snapshotPath'))
        self.collectors = collectors; self.last_refresh = 0.; self.refreshing = None; self.guard = threading.Lock(); self.failures = 0
        self.cooldown = {}; self.account_cache = {}; self.attempted = {}; self.delivery_thread = None
        self.stop_event = threading.Event(); self.poll_thread = None
    def start_polling(self):
        if self.poll_thread: return
        def loop():
            while not self.stop_event.is_set():
                try: self.refresh()
                except Exception as exc: logging.warning('refresh_failed: %s', type(exc).__name__)
                base = max(60, int(self.config.get("pollSeconds", 300)))
                delay = base * random.uniform(.9, 1.0)
                self.stop_event.wait(delay)
        self.poll_thread = threading.Thread(target=loop, name="most-monitor-poll", daemon=True); self.poll_thread.start()
    def stop(self):
        self.stop_event.set()
        if self.poll_thread: self.poll_thread.join(timeout=45)
        if self.delivery_thread: self.delivery_thread.join(timeout=30)
    def refresh(self, max_age=0):
        with self.guard:
            if self.refreshing: future = self.refreshing
            elif time.time() - self.last_refresh < 5: return self.core.snapshot()
            else:
                future = concurrent.futures.Future(); self.refreshing = future
                threading.Thread(target=self._refresh, args=(future,max_age), daemon=True).start()
        return future.result(timeout=45)
    def _refresh(self, future, max_age=0):
        try:
            if self.collectors is None:
                import collectors as c
                funcs = [lambda: c.collect_codex(self.config), lambda: c.collect_claude(self.config)]
            else: funcs = list(self.collectors)
            # Collector subprocess deadlines provide the hard stop; provider failures are isolated.
            def collect(index, fn):
                provider = ('codex', 'claude')[index] if index < 2 else str(index)
                cached = self.account_cache.get(provider)
                if max_age and cached and cached.get('status') == 'fresh' and time.time() - (cached.get('observedAt') or 0) < max_age and time.time() < (cached.get('validUntil') or 0):
                    return cached
                if time.time() < self.cooldown.get(provider, 0) and provider in self.account_cache:
                    return self.account_cache[provider]
                try: account = fn()
                except Exception:
                    from collectors import base, error, CollectionError
                    account = error(base(provider), CollectionError('collector_failed'))
                self.attempted[provider] = time.time()
                if account.get('status') == 'fresh':
                    self.cooldown[provider] = 0; self.account_cache[provider] = account
                else:
                    old_delay = self.account_cache.get(provider, {}).get('retrySeconds', 30)
                    delay = min(3600, max(60, old_delay * 2))
                    account['retrySeconds'] = delay; self.cooldown[provider] = time.time() + delay; self.account_cache[provider] = account
                return account
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
                futures = [ex.submit(collect, i, fn) for i, fn in enumerate(funcs)]
                accounts = [f.result(timeout=40) for f in futures]
            result=self.core.ingest(accounts); self.last_refresh=time.time(); self.failures=0; future.set_result(result)
            if not self.delivery_thread or not self.delivery_thread.is_alive():
                self.delivery_thread = threading.Thread(target=self.core.deliver_pending, daemon=True); self.delivery_thread.start()
        except Exception as exc:
            self.failures=min(self.failures+1, 6); future.set_exception(exc)
        finally:
            with self.guard: self.refreshing=None
    def usage(self, max_age=300, **filters):
        max_age=max(0, min(int(max_age), 3600)); s=self.core.snapshot(**filters)
        now = time.time()
        needs = s is None or not s['accounts'] or any(a.get('status') != 'fresh' or now - (a.get('observedAt') or 0) > max_age for a in s['accounts'])
        if needs and (s is None or now-self.last_refresh >= 5): self.refresh(max_age)
        s = self.core.snapshot(**filters)
        if s:
            s['maxAgeSatisfied'] = bool(s['accounts']) and all(a.get('status') == 'fresh' and time.time()-(a.get('observedAt') or 0) <= max_age for a in s['accounts'])
        return s

def load_config(path=None):
    path=Path(path or Path(__file__).with_name("config.json")); data=json.loads(path.read_text(encoding="utf-8"))
    data.setdefault("port",1236); data.setdefault("pollSeconds",300); data.setdefault("notifications",True)
    if not data.get("dataDir"): raise ValueError("dataDir is required")
    return data

def _handler(service):
 class Handler(BaseHTTPRequestHandler):
  def log_message(self,*args): pass
  def _guard(self):
   host=self.headers.get("Host","").split(":")[0]
   return self.headers.get("X-Most-Client")=="local-v1" and 'Origin' not in self.headers and host in ("127.0.0.1","localhost")
  def _send(self, status, value):
   raw=json.dumps(value,allow_nan=False).encode(); self.send_response(status); self.send_header("Content-Type","application/json"); self.send_header("Cache-Control","no-store"); self.send_header("Content-Length",str(len(raw))); self.end_headers(); self.wfile.write(raw)
  def do_GET(self):
   if not self._guard(): return self._send(403,{"error":"local client required"})
   p=urlparse(self.path); q=parse_qs(p.query)
   try:
    if p.path=="/most/v1/usage": return self._send(200,service.usage(q.get("maxAge",[300])[0],provider=q.get("provider",[None])[0],account_ref=q.get("accountRef",[None])[0],host_id=q.get("hostId",[None])[0]))
    if p.path=="/most/v1/history": return self._send(200,{"history":service.core.history(q.get("limit",[200])[0])})
    if p.path=="/most/v1/routing-status": return self._send(200,{"usage_status":"available","recommend_model":"unsupported"})
    return self._send(404,{"error":"not found"})
   except (ValueError,TimeoutError) as e: return self._send(400,{"error":str(e)})
   except Exception: return self._send(503,{"error":"unavailable"})
  def do_POST(self):
   if not self._guard(): return self._send(403,{"error":"local client required"})
   if urlparse(self.path).path!="/most/v1/refresh": return self._send(404,{"error":"not found"})
   try: return self._send(200,service.refresh())
   except Exception: return self._send(503,{"error":"unavailable"})
 return Handler

def main(argv=None):
 p=argparse.ArgumentParser(description="Most monitor. Agent API: /most/v1/usage with X-Most-Client: local-v1")
 p.add_argument("--config"); sub=p.add_subparsers(dest="command",required=True)
 for n in ("usage_status","history","routing_status"):
  child=sub.add_parser(n)
  if n=='usage_status':
   child.add_argument('--max-age',type=int,default=300); child.add_argument('--provider'); child.add_argument('--account-ref'); child.add_argument('--host-id')
 sub.add_parser("serve"); ns=p.parse_args(argv); config=load_config(ns.config)
 if ns.command=="serve":
  Path(config['dataDir']).mkdir(parents=True,exist_ok=True)
  log=RotatingFileHandler(str(Path(config['dataDir'])/'monitor.log'),maxBytes=512000,backupCount=2,encoding='utf-8')
  logging.basicConfig(handlers=[log],level=logging.INFO,format='%(asctime)s %(levelname)s %(message)s')
  # Acquire the single-instance port BEFORE opening SQLite or starting collectors.
  server=ThreadingHTTPServer(("127.0.0.1",int(config["port"])),BaseHTTPRequestHandler)
  try: service=Service(config)
  except Exception: server.server_close(); raise
  server.RequestHandlerClass=_handler(service); service.start_polling(); logging.info('monitor_started port=%s',config['port'])
  try: server.serve_forever()
  finally: service.stop(); server.server_close(); service.core.close()
  return 0
 # CLI deliberately does not collect: it must talk to the running daemon.
 import urllib.request
 from urllib.parse import urlencode
 query={}
 if ns.command=='usage_status':
  query={'maxAge':ns.max_age}
  for key,attr in [('provider','provider'),('accountRef','account_ref'),('hostId','host_id')]:
   if getattr(ns,attr):query[key]=getattr(ns,attr)
 endpoints={"usage_status":"usage?"+urlencode(query),"history":"history?limit=200","routing_status":"routing-status"}
 try:
  req=urllib.request.Request("http://127.0.0.1:%s/most/v1/%s"%(config["port"],endpoints[ns.command]),headers={"X-Most-Client":"local-v1"})
  with urllib.request.urlopen(req,timeout=45) as response: print(response.read().decode())
  return 0
 except Exception:
  print(json.dumps({"error":"service_unavailable"})); return 2
if __name__=="__main__": raise SystemExit(main())
