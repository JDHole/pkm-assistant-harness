# -*- coding: utf-8 -*-
"""
Most ChatGPT dla PKM Assistant - wlasny async proxy + supervisor + tray widget.
Autor: Claudzik, 2026-08-14. Inicjatywa: Lepszy most 2026.

Architektura:
  plugin (port 1234) -> MOST (aiohttp, ten plik) -> ChatMock (port 1235) -> chatgpt.com

Kontrakt providera, ktory ten plik gwarantuje:
  1. Rownolegle polaczenia przyjete zawsze; do backendu max MAX_CONCURRENT naraz,
     reszta czeka w uczciwej kolejce (FIFO semafora).
  2. Saturacja = glosne 429 z Retry-After, nigdy cisza.
  3. Brak pierwszego bajta w FIRST_BYTE_TIMEOUT = glosne 503 (i restart backendu).
  4. Cisza w srodku streamu: heartbeat SSE co HEARTBEAT_INTERVAL, twarde ciecie
     po STALL_TIMEOUT z komunikatem bledu.
  5. Supervisor: ChatMock to proces-dziecko; padniecie/zwis = auto-restart
     (z cooldownem i bezpiecznikiem na petle restartow).
  6. Kurowana lista modeli + tryb oszczedny (most_models.json), health przez /v1/models.
  7. chatgpt.com czasem oddaje HTTP 200 i otwiera SSE, a potem urywa je zdarzeniem
     response.failed / chunkiem {"error": {...}} (ChatMock przepuszcza to jako czesc
     streamu, status HTTP zostaje 200) - nikt tego nie retry'uje (plugin retry'uje
     tylko po 429). Most klasyfikuje pierwszy chunk PRZED wyslaniem czegokolwiek
     klientowi: przy statusie 429/500/502/503/504 albo error-chunku z komunikatem
     o przeciazeniu/timeout/rate limit ponawia cala probe (UPSTREAM_RETRIES razy,
     opoznienia z MOST_RETRY_DELAYS), a po wyczerpaniu prob oddaje 429 z Retry-After -
     zeby zadzialal wlasny backoff pluginu.

Tray: ikonka kolorowa (zielona/zolta/czerwona), tooltip = limit tygodniowy
ze snapshotu ChatMocka (~/.chatgpt-local/usage_limits.json), menu = restart /
odswiez limit / logi / autostart / zamknij.
"""
from __future__ import annotations

import asyncio
import ctypes
import json
import logging
import logging.handlers
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import aiohttp
from aiohttp import web

# ------------------------------------------------------------------ konfiguracja

def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default

HOME = Path(os.path.expanduser("~"))
BASE_DIR = Path(os.getenv("MOST_BASE_DIR") or (HOME / ".chatgpt-local"))
MOST_DIR = BASE_DIR / "most"
USAGE_PATH = BASE_DIR / "usage_limits.json"
MODELS_PATH = MOST_DIR / "most_models.json"
CHATMOCK_EXE = r"C:\Users\jdziu\AppData\Local\Programs\Python\Python312\Scripts\chatmock.exe"

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = _env_int("MOST_LISTEN_PORT", 1234)
BACKEND_PORT = _env_int("MOST_BACKEND_PORT", 1235)
BACKEND_URL = f"http://127.0.0.1:{BACKEND_PORT}"

MAX_CONCURRENT = _env_int("MOST_MAX_CONCURRENT", 6)      # slotow do backendu naraz
QUEUE_MAX_DEPTH = _env_int("MOST_QUEUE_MAX_DEPTH", 16)   # czekajacych; powyzej -> 429 od reki
QUEUE_MAX_WAIT = _env_int("MOST_QUEUE_MAX_WAIT", 45)     # s czekania na slot -> 429
FIRST_BYTE_TIMEOUT = _env_int("MOST_FIRST_BYTE_TIMEOUT", 100)  # s do 1. bajta -> 503 (< watchdog 120s pluginu)
STALL_TIMEOUT = _env_int("MOST_STALL_TIMEOUT", 180)      # s ciszy w srodku streamu -> ciecie
HEARTBEAT_INTERVAL = _env_int("MOST_HEARTBEAT", 15)      # s; komentarz SSE gdy backend milczy
HEALTH_INTERVAL = _env_int("MOST_HEALTH_INTERVAL", 300)  # s; test /v1/models gdy brak ruchu tyle czasu
HEALTH_TICK = _env_int("MOST_HEALTH_TICK", 60)            # s; takt petli zdrowia
USAGE_REFRESH = _env_int("MOST_USAGE_REFRESH", 1800)      # s; co ile odswiezac snapshot limitu mikro-pingiem
PING_MODEL = os.getenv("MOST_PING_MODEL", "gpt-5.5-low")
RESTART_COOLDOWN = 60                                     # s miedzy auto-restartami
RESTART_MAX = 4                                           # auto-restartow w oknie...
RESTART_WINDOW = 15 * 60                                  # ...15 minut; potem stan DOWN, czeka na reke
NO_SPAWN = os.getenv("MOST_NO_SPAWN") == "1"              # testy: nie odpalaj ChatMocka
NO_TRAY = os.getenv("MOST_NO_TRAY") == "1"                # testy: bez ikonki

UPSTREAM_RETRIES = _env_int("MOST_UPSTREAM_RETRIES", 3)  # ile ponowien przy przejsciowej awarii upstreamu


def _parse_retry_delays(raw: str) -> list[float]:
    """'2,5,10' -> [2.0, 5.0, 10.0]. Wpisy nie-liczbowe ignorowane; pusty/bledny wynik -> domyslne."""
    delays: list[float] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            delays.append(float(part))
        except ValueError:
            continue
    return delays or [2.0, 5.0, 10.0]


RETRY_DELAYS = _parse_retry_delays(os.getenv("MOST_RETRY_DELAYS", "2,5,10"))

HEAVY_MARKERS = ("completions", "responses", "embeddings")
HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
               "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length"}

STARTUP_DIR = HOME / "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup"
AUTOSTART_VBS = STARTUP_DIR / "Most-ChatGPT-PKM.vbs"
PYTHONW = Path(sys.executable).with_name("pythonw.exe")

# ------------------------------------------------------------------ logi

MOST_DIR.mkdir(parents=True, exist_ok=True)
log = logging.getLogger("most")
log.setLevel(logging.INFO)
_h = logging.handlers.RotatingFileHandler(MOST_DIR / "most.log", maxBytes=5_000_000,
                                          backupCount=2, encoding="utf-8")
_h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
log.addHandler(_h)
if sys.stdout and sys.stdout.isatty():
    _c = logging.StreamHandler()
    _c.setFormatter(_h.formatter)
    log.addHandler(_c)

# ------------------------------------------------------------------ stan mostu

class MostState:
    def __init__(self) -> None:
        self.started_at = time.time()
        self.backend_state = "starting"   # starting | ok | suspect | down
        self.last_upstream_ok = 0.0       # ostatni udany request przez chatgpt.com
        self.last_backend_ok = 0.0        # ostatnia udana odpowiedz backendu (np. /v1/models)
        self.last_ping_attempt = 0.0      # ostatnia proba mikro-pingu (udana czy nie)
        self.in_flight = 0
        self.queued = 0
        self.served_total = 0
        self.errors_total = 0
        self.retries_total = 0            # kazda proba ponowienia po przejsciowej awarii upstreamu
        self.retry_rescued_total = 0      # requesty ktore udalo sie domknac po >=1 ponowieniu
        self.restarts: list[float] = []   # timestampy auto-restartow
        self.restart_reason = ""
        self.lock = threading.Lock()

STATE = MostState()
SEM = asyncio.Semaphore(MAX_CONCURRENT)
_tray_refresh = lambda: None  # podpinane po starcie tray


def now() -> float:
    return time.time()

# ------------------------------------------------------------------ supervisor ChatMocka

class Supervisor:
    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self._restart_lock = asyncio.Lock()

    def _open_log(self, name: str):
        p = BASE_DIR / name
        try:
            if p.exists() and p.stat().st_size > 10_000_000:
                old = p.with_suffix(p.suffix + ".old")
                old.unlink(missing_ok=True)
                p.rename(old)
        except OSError:
            pass
        return open(p, "ab")

    def kill_port(self, port: int) -> None:
        cmd = (f"Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue "
               f"| ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force }}")
        subprocess.run(["powershell", "-NoProfile", "-Command", cmd],
                       capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)

    def start(self) -> None:
        if NO_SPAWN:
            log.info("NO_SPAWN=1 - nie odpalam ChatMocka, licze na zewnetrzny backend %s", BACKEND_URL)
            return
        self.kill_port(BACKEND_PORT)
        env = dict(os.environ, PYTHONUNBUFFERED="1")
        # --reasoning-summary detailed (Front C, 2026-08-17): default 'auto' oddawal
        # streszczenia rozumowania jako pojedyncze naglowki ("Planning tool delegation") -
        # w pluginie blok Myslenia wygladal na zepsuty. 'detailed' = pelniejsze streszczenia,
        # streamowane na zywo tym samym kanalem. UWAGA: surowego CoT OpenAI nie wystawia
        # wcale - streszczenie to maksimum tego, co istnieje. Bug pluginu 2026-08-09.
        self.proc = subprocess.Popen(
            [CHATMOCK_EXE, "serve", "--port", str(BACKEND_PORT), "--expose-reasoning-models",
             "--reasoning-summary", "detailed"],
            stdout=self._open_log("chatmock.log"), stderr=self._open_log("chatmock.err.log"),
            creationflags=subprocess.CREATE_NO_WINDOW, env=env,
        )
        log.info("ChatMock wystartowal (pid %s, port %s)", self.proc.pid, BACKEND_PORT)

    def alive(self) -> bool:
        if NO_SPAWN:
            return True
        return self.proc is not None and self.proc.poll() is None

    def stop(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None
        if not NO_SPAWN:
            self.kill_port(BACKEND_PORT)

    async def wait_ready(self, timeout: float = 40.0) -> bool:
        deadline = now() + timeout
        async with aiohttp.ClientSession() as s:
            while now() < deadline:
                try:
                    async with s.get(f"{BACKEND_URL}/v1/models",
                                     timeout=aiohttp.ClientTimeout(total=5)) as r:
                        if r.status == 200:
                            STATE.last_backend_ok = now()
                            return True
                except aiohttp.ClientError:
                    pass
                except asyncio.TimeoutError:
                    pass
                await asyncio.sleep(1.0)
        return False

    async def restart(self, reason: str, manual: bool = False) -> bool:
        async with self._restart_lock:
            cutoff = now() - RESTART_WINDOW
            STATE.restarts = [t for t in STATE.restarts if t > cutoff]
            if not manual:
                if STATE.restarts and now() - STATE.restarts[-1] < RESTART_COOLDOWN:
                    log.warning("restart pominiety (cooldown): %s", reason)
                    return False
                if len(STATE.restarts) >= RESTART_MAX:
                    STATE.backend_state = "down"
                    STATE.restart_reason = f"petla restartow ({reason})"
                    log.error("bezpiecznik: %s auto-restartow w %s min - stan DOWN, czekam na reke",
                              RESTART_MAX, RESTART_WINDOW // 60)
                    _tray_refresh()
                    return False
                STATE.restarts.append(now())
            log.warning("RESTART backendu, powod: %s", reason)
            STATE.backend_state = "starting"
            STATE.restart_reason = reason
            _tray_refresh()
            self.stop()
            await asyncio.sleep(1.0)
            self.start()
            ok = await self.wait_ready()
            STATE.backend_state = "ok" if ok else "down"
            if manual and ok:
                STATE.restarts = []
            log.info("backend po restarcie: %s", STATE.backend_state)
            _tray_refresh()
            return ok

SUP = Supervisor()

# ------------------------------------------------------------------ odczyt limitu

WEEKLY_MIN_MINUTES = 7 * 24 * 60


def _window(raw: dict, cap_dt: datetime) -> dict:
    return {
        "used_percent": float(raw.get("used_percent") or 0.0),
        "window_minutes": int(raw.get("window_minutes") or 0),
        "reset_at": cap_dt.timestamp() + float(raw.get("resets_in_seconds") or 0),
    }


def read_usage() -> dict | None:
    """Snapshot limitu z pliku ChatMocka. Rozbija na okno krotkie (5h) i tygodniowe."""
    try:
        raw = json.loads(USAGE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    captured = raw.get("captured_at")
    if captured is None:
        return None
    try:
        cap_dt = datetime.fromisoformat(captured)
    except ValueError:
        return None

    short = None
    weekly = None
    for key in ("primary", "secondary"):
        w = raw.get(key)
        if not isinstance(w, dict):
            continue
        if (w.get("window_minutes") or 0) >= WEEKLY_MIN_MINUTES:
            weekly = _window(w, cap_dt)
        else:
            short = _window(w, cap_dt)

    return {
        "short": short,
        "weekly": weekly,
        "captured_at": cap_dt,
        "age_s": max(0.0, now() - cap_dt.timestamp()),
    }


def fmt_dur(seconds: float) -> str:
    seconds = max(0, int(seconds))
    d, r = divmod(seconds, 86400)
    h, r = divmod(r, 3600)
    m, _ = divmod(r, 60)
    if d:
        return f"{d}d {h}h"
    if h:
        return f"{h}h {m}m"
    return f"{m}m"

# ------------------------------------------------------------------ lista modeli (kurowana) + eco mode

DEFAULT_MODELS_CFG = {
    "_komentarz": ("Lista modeli, ktora widzi plugin pod /v1/models. 'eco' = model uzyty zamiast tego, "
                   "gdy eco_mode = true. Plik czytany na kazdy request, restart mostu niepotrzebny."),
    "eco_mode": False,
    "models": [
        {"id": "gpt-6-astra-low", "upstream": "gpt-6-astra", "effort": "low", "eco": "gpt-5.6-sol-xhigh"},
        {"id": "gpt-6-astra-medium", "upstream": "gpt-6-astra", "effort": "medium", "eco": "gpt-5.6-sol-xhigh"},
        {"id": "gpt-6-astra-high", "upstream": "gpt-6-astra", "effort": "high", "eco": "gpt-5.6-sol-xhigh"},
        {"id": "gpt-6-astra-xhigh", "upstream": "gpt-6-astra", "effort": "xhigh", "eco": "gpt-5.6-sol-xhigh"},
        {"id": "gpt-5.6-sol-high", "upstream": "gpt-5.6-sol", "effort": "high"},
        {"id": "gpt-5.6-sol-xhigh", "upstream": "gpt-5.6-sol", "effort": "xhigh"},
        {"id": "gpt-5.6-terra-medium", "upstream": "gpt-5.6-terra", "effort": "medium"},
        {"id": "gpt-5.6-terra-high", "upstream": "gpt-5.6-terra", "effort": "high"},
        {"id": "gpt-5.6-luna-medium", "upstream": "gpt-5.6-luna", "effort": "medium"},
        {"id": "gpt-5.5-low", "upstream": "gpt-5.5", "effort": "low"},
    ],
}


class _ModelsCache:
    def __init__(self) -> None:
        self.mtime: float | None = None
        self.data: dict = {"eco_mode": False, "models": []}
        self.by_id: dict[str, dict] = {}
        self.bad_mtime: float | None = None


_MODELS_CACHE = _ModelsCache()


def _write_default_models_cfg() -> None:
    MOST_DIR.mkdir(parents=True, exist_ok=True)
    MODELS_PATH.write_text(json.dumps(DEFAULT_MODELS_CFG, indent=2, ensure_ascii=False), encoding="utf-8")
    log.info("most_models.json nie istnial - zapisalem domyslna liste (%s modeli)",
             len(DEFAULT_MODELS_CFG["models"]))


def _validate_models_cfg(raw: dict) -> dict:
    eco_mode = bool(raw.get("eco_mode", False))
    models_in = raw.get("models")
    entries: list[dict] = []
    ids: set[str] = set()
    if isinstance(models_in, list):
        for m in models_in:
            if not isinstance(m, dict):
                continue
            mid = m.get("id")
            upstream = m.get("upstream")
            if not isinstance(mid, str) or not isinstance(upstream, str):
                continue
            entry = {"id": mid, "upstream": upstream}
            effort = m.get("effort")
            if isinstance(effort, str):
                entry["effort"] = effort
            eco = m.get("eco")
            if isinstance(eco, str):
                entry["eco"] = eco
            entries.append(entry)
            ids.add(mid)
    # eco musi wskazywac na istniejace id, inaczej ignorujemy z ostrzezeniem
    for entry in entries:
        eco = entry.get("eco")
        if eco is not None and eco not in ids:
            log.warning("most_models.json: model %s ma eco=%s ktore nie istnieje - ignoruje", entry["id"], eco)
            del entry["eco"]
    return {"eco_mode": eco_mode, "models": entries}


def load_models_cfg() -> dict:
    """Wczytuje most_models.json z cache po mtime; pisze domyslny plik gdy brak."""
    if not MODELS_PATH.exists():
        _write_default_models_cfg()
    try:
        mtime = MODELS_PATH.stat().st_mtime
    except OSError:
        return _MODELS_CACHE.data
    if _MODELS_CACHE.mtime == mtime:
        return _MODELS_CACHE.data
    try:
        raw = json.loads(MODELS_PATH.read_text(encoding="utf-8"))
        cfg = _validate_models_cfg(raw)
    except (OSError, ValueError) as e:
        if _MODELS_CACHE.bad_mtime != mtime:
            log.error("most_models.json nie do odczytu (%s) - zostaje poprzednia konfiguracja", e)
            _MODELS_CACHE.bad_mtime = mtime
        return _MODELS_CACHE.data
    _MODELS_CACHE.mtime = mtime
    _MODELS_CACHE.data = cfg
    _MODELS_CACHE.by_id = {m["id"]: m for m in cfg["models"]}
    return cfg


def models_by_id() -> dict[str, dict]:
    load_models_cfg()
    return _MODELS_CACHE.by_id


def eco_mode_on() -> bool:
    return bool(load_models_cfg().get("eco_mode", False))


def set_eco_mode(on: bool) -> dict:
    """Nadpisuje TYLKO klucz eco_mode w pliku, reszta (w tym _komentarz) zostaje bez zmian."""
    if not MODELS_PATH.exists():
        _write_default_models_cfg()
    try:
        raw = json.loads(MODELS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = dict(DEFAULT_MODELS_CFG)
    raw["eco_mode"] = bool(on)
    MODELS_PATH.write_text(json.dumps(raw, indent=2, ensure_ascii=False), encoding="utf-8")
    _MODELS_CACHE.mtime = None  # wymus przeladowanie przy najblizszym odczycie
    cfg = load_models_cfg()
    log.info("tryb oszczedny: %s", "wlaczony" if cfg["eco_mode"] else "wylaczony")
    return cfg


async def handle_models(request: web.Request) -> web.Response:
    cfg = load_models_cfg()
    data = [{"id": m["id"], "object": "model", "owned_by": "most"} for m in cfg["models"]]
    return web.json_response({"object": "list", "data": data},
                             headers={"Access-Control-Allow-Origin": "*"})


async def handle_eco(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except (json.JSONDecodeError, ValueError):
        payload = {}
    on = bool(payload.get("on"))
    cfg = set_eco_mode(on)
    return web.json_response({"eco_mode": cfg["eco_mode"]})


def _rewrite_model_body(body: bytes) -> tuple[bytes, bool]:
    """Podmienia model+effort na wpis z kurowanej listy (jesli pasuje). Nieznane nazwy
    przechodza bajt-w-bajt bez zmian - stare nazwy dzialaja dalej wprost przez ChatMocka."""
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return body, False
    if not isinstance(payload, dict):
        return body, False
    model = payload.get("model")
    if not isinstance(model, str):
        return body, False

    entry = models_by_id().get(model)
    if entry is None:
        return body, False

    use_entry = entry
    eco_suffix = ""
    if eco_mode_on() and entry.get("eco"):
        eco_entry = models_by_id().get(entry["eco"])
        if eco_entry is not None:
            use_entry = eco_entry
            eco_suffix = " [ECO]"

    payload["model"] = use_entry["upstream"]
    effort = use_entry.get("effort")
    if effort:
        reasoning = payload.get("reasoning")
        reasoning = dict(reasoning) if isinstance(reasoning, dict) else {}
        reasoning["effort"] = effort
        payload["reasoning"] = reasoning

    log.info("model %s -> %s (effort %s)%s", model, use_entry["upstream"], effort, eco_suffix)
    return json.dumps(payload, ensure_ascii=False).encode("utf-8"), True

# ------------------------------------------------------------------ proxy HTTP

def _is_heavy(request: web.Request) -> bool:
    return request.method == "POST" and any(m in request.path for m in HEAVY_MARKERS)


def _json_error(status: int, message: str, retry_after: int | None = None) -> web.Response:
    headers = {"Access-Control-Allow-Origin": "*"}
    if retry_after is not None:
        headers["Retry-After"] = str(retry_after)
    return web.json_response(
        {"error": {"message": message, "type": "most_error", "code": status}},
        status=status, headers=headers,
    )


async def handle_status(request: web.Request) -> web.Response:
    # usage jest zawsze obiektem (nie None) - eco_mode ma byc widoczne w /most/status
    # nawet zanim ChatMock w ogole zdazyl napisac usage_limits.json.
    usage = read_usage()
    weekly = usage["weekly"] if usage else None
    short = usage["short"] if usage else None
    return web.json_response({
        "state": STATE.backend_state,
        "uptime_s": int(now() - STATE.started_at),
        "in_flight": STATE.in_flight,
        "queued": STATE.queued,
        "served_total": STATE.served_total,
        "errors_total": STATE.errors_total,
        "retries_total": STATE.retries_total,
        "retry_rescued_total": STATE.retry_rescued_total,
        "last_upstream_ok_ago_s": int(now() - STATE.last_upstream_ok) if STATE.last_upstream_ok else None,
        "restarts_recent": len(STATE.restarts),
        "restart_reason": STATE.restart_reason,
        "usage": {
            "weekly_used_percent": weekly["used_percent"] if weekly else None,
            "resets_in": fmt_dur(weekly["reset_at"] - now()) if weekly else None,
            "snapshot_age": fmt_dur(usage["age_s"]) if usage else None,
            "short_used_percent": short["used_percent"] if short else None,
            "short_window_minutes": short["window_minutes"] if short else None,
            "short_resets_in": fmt_dur(short["reset_at"] - now()) if short else None,
            "eco_mode": eco_mode_on(),
        },
    })


async def handle_restart(request: web.Request) -> web.Response:
    ok = await SUP.restart("guzik / endpoint /most/restart", manual=True)
    return web.json_response({"ok": ok, "state": STATE.backend_state}, status=200 if ok else 503)


_TRANSIENT_STATUSES = {429, 500, 502, 503, 504}
_TRANSIENT_MSG_RE = re.compile(
    r"overloaded|try again|temporarily|rate limit|server error|timed out|timeout|"
    r"connection reset|upstream",
    re.IGNORECASE,
)


def _truncate(msg: str | None, limit: int = 120) -> str:
    msg = msg or ""
    return msg if len(msg) <= limit else msg[: limit - 3] + "..."


def _first_sse_data_json(text: str) -> tuple[bool, dict | None]:
    """Pierwsza linia 'data: ...' w bloku SSE. Zwraca (znaleziono, sparsowany_json_albo_None) -
    [DONE] albo JSON nie do sparsowania traktujemy jak 'znaleziono, ale brak errora'."""
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if payload == "[DONE]":
            return True, None
        try:
            return True, json.loads(payload)
        except (json.JSONDecodeError, ValueError):
            return True, None
    return False, None


def _classify_transient(status: int, first_chunk: bytes | None, is_sse: bool) -> tuple[bool, str]:
    """Klasyfikuje odpowiedz upstreamu PRZED wyslaniem czegokolwiek klientowi.
    Zwraca (transient, opis_powodu_do_logu/bledu)."""
    if status in _TRANSIENT_STATUSES:
        return True, f"HTTP {status}"
    if status >= 400:
        return False, f"HTTP {status}"
    if not first_chunk:
        return False, ""

    text = first_chunk.decode("utf-8", errors="replace")
    error_obj: dict | None = None
    if is_sse:
        found, obj = _first_sse_data_json(text)
        if not found:
            return False, ""  # brak linii 'data:' w pierwszym chunku -> normalny stream
        if isinstance(obj, dict) and isinstance(obj.get("error"), dict):
            error_obj = obj["error"]
    else:
        try:
            obj = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            return False, ""
        if isinstance(obj, dict) and isinstance(obj.get("error"), dict):
            error_obj = obj["error"]

    if error_obj is None:
        return False, ""
    message = error_obj.get("message")
    message = message if isinstance(message, str) else ""
    return bool(_TRANSIENT_MSG_RE.search(message)), message


async def _pump(request: web.Request, client: aiohttp.ClientSession) -> web.StreamResponse:
    """Przekazanie requestu do backendu z watchdogami pierwszego bajta i ciszy.
    Dla ciezkich requestow: przy przejsciowej awarii upstreamu (patrz _classify_transient)
    ponawia cala probe PRZED wyslaniem czegokolwiek klientowi - punkt 7 kontraktu na szczycie pliku."""
    body = await request.read()
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_HEADERS}

    heavy = _is_heavy(request)
    if heavy and body:
        body, changed = _rewrite_model_body(body)
        if changed:
            headers["Content-Type"] = "application/json"

    first_byte_limit = FIRST_BYTE_TIMEOUT if heavy else 30
    max_attempts = (UPSTREAM_RETRIES + 1) if heavy else 1

    upstream: aiohttp.ClientResponse
    first_chunk: bytes | None = None
    is_sse = False
    iterator = None
    attempt = 0

    while True:
        attempt += 1
        try:
            # wait_for na cala faze naglowkow: backend, ktory przyjal request i milczy
            # (zero naglowkow odpowiedzi), tez ma dostac glosne 503, nie wieczna cisze
            upstream = await asyncio.wait_for(
                client.request(
                    request.method, BACKEND_URL + request.path_qs,
                    headers=headers, data=body if body else None,
                    timeout=aiohttp.ClientTimeout(total=None, connect=10, sock_connect=10, sock_read=None),
                ),
                timeout=first_byte_limit,
            )
        except asyncio.TimeoutError:
            STATE.errors_total += 1
            log.error("CISZA: brak naglowkow odpowiedzi w %ss (%s %s) - 503 + restart",
                      first_byte_limit, request.method, request.path)
            asyncio.get_running_loop().create_task(SUP.restart("brak naglowkow odpowiedzi"))
            return _json_error(503, f"Most: backend przyjal request i zamilkl na {first_byte_limit}s. "
                                    "Zwis zgloszony, restart w toku.", retry_after=30)
        except aiohttp.ClientError as e:
            STATE.errors_total += 1
            log.error("backend nieosiagalny (%s %s): %s", request.method, request.path, e)
            asyncio.get_running_loop().create_task(SUP.restart(f"nieosiagalny: {e.__class__.__name__}"))
            return _json_error(503, "Most: ChatMock nie odpowiada (restart w toku). Sprobuj za chwile.", retry_after=20)

        is_sse = "text/event-stream" in (upstream.headers.get("Content-Type") or "")
        iterator = upstream.content.iter_any().__aiter__()

        # pierwszy bajt PRZED wyslaniem naglowkow klientowi - na timeout idzie czyste 503
        try:
            first_chunk = await asyncio.wait_for(iterator.__anext__(), timeout=first_byte_limit)
        except StopAsyncIteration:
            first_chunk = None
        except asyncio.TimeoutError:
            STATE.errors_total += 1
            log.error("CISZA: brak pierwszego bajta w %ss (%s %s) - 503 + restart",
                      first_byte_limit, request.method, request.path)
            upstream.close()
            asyncio.get_running_loop().create_task(SUP.restart("brak pierwszego bajta"))
            return _json_error(503, f"Most: backend przyjal request i zamilkl na {first_byte_limit}s. "
                                    "Zwis zgloszony, restart w toku.", retry_after=30)

        if not heavy:
            break

        transient, reason = _classify_transient(upstream.status, first_chunk, is_sse)
        if not transient:
            break

        if attempt >= max_attempts:
            STATE.errors_total += 1
            message = _truncate(reason)
            upstream.close()
            log.error("UPSTREAM: %d prob nieudanych, poddaje sie (%s) - 429 dla klienta", attempt, message)
            return _json_error(429, f"Most: backend OpenAI przeciazony ({attempt} prob): {message}",
                               retry_after=30)

        delay = RETRY_DELAYS[min(attempt - 1, len(RETRY_DELAYS) - 1)]
        STATE.retries_total += 1
        kind = "status" if reason.startswith("HTTP ") else "error"
        log.warning("UPSTREAM pad (proba %d/%d, %s): %s - powtarzam za %.1fs",
                    attempt, UPSTREAM_RETRIES, kind, _truncate(reason), delay)
        upstream.close()
        await asyncio.sleep(delay)
        # petla: kolejna proba tego samego requestu (metoda/path/headers/body bez zmian)

    if heavy and attempt > 1:
        STATE.retry_rescued_total += 1
        log.info("UPSTREAM uratowany po %d ponowieniach (%s)", attempt - 1, request.path)

    try:
        resp = web.StreamResponse(status=upstream.status)
        for k, v in upstream.headers.items():
            if k.lower() not in HOP_HEADERS and k.lower() != "content-length":
                resp.headers[k] = v
        await resp.prepare(request)
        if first_chunk:
            await resp.write(first_chunk)

        silent = 0.0
        while True:
            try:
                chunk = await asyncio.wait_for(iterator.__anext__(), timeout=HEARTBEAT_INTERVAL)
            except StopAsyncIteration:
                break
            except asyncio.TimeoutError:
                silent += HEARTBEAT_INTERVAL
                if silent >= STALL_TIMEOUT:
                    STATE.errors_total += 1
                    log.error("STALL: %ss ciszy w streamie (%s) - ciecie + restart", int(silent), request.path)
                    if is_sse:
                        await resp.write(b'data: {"error":{"message":"Most: backend zamilkl w srodku streamu, polaczenie uciete."}}\n\n')
                    asyncio.get_running_loop().create_task(SUP.restart("stall w srodku streamu"))
                    break
                if is_sse:
                    await resp.write(b": most-heartbeat\n\n")
                continue
            silent = 0.0
            await resp.write(chunk)

        await resp.write_eof()
        if upstream.status < 400:
            STATE.served_total += 1
            STATE.last_backend_ok = now()
            if _is_heavy(request):
                STATE.last_upstream_ok = now()
        else:
            STATE.errors_total += 1
        return resp
    finally:
        upstream.close()


async def handle_proxy(request: web.Request) -> web.StreamResponse:
    client: aiohttp.ClientSession = request.app["client"]
    if not _is_heavy(request):
        return await _pump(request, client)

    # uczciwa kolejka: semafor FIFO, glosne 429 przy przepelnieniu / przeczekaniu
    if STATE.queued >= QUEUE_MAX_DEPTH:
        STATE.errors_total += 1
        log.warning("SATURACJA: kolejka pelna (%s), 429 dla %s", STATE.queued, request.path)
        return _json_error(429, f"Most: kolejka pelna ({STATE.queued} czekajacych). Sprobuj za chwile.",
                           retry_after=15)
    STATE.queued += 1
    try:
        try:
            await asyncio.wait_for(SEM.acquire(), timeout=QUEUE_MAX_WAIT)
        except asyncio.TimeoutError:
            STATE.errors_total += 1
            log.warning("SATURACJA: %ss w kolejce bez slotu, 429 dla %s", QUEUE_MAX_WAIT, request.path)
            return _json_error(429, f"Most: {QUEUE_MAX_WAIT}s w kolejce bez wolnego slotu. Sprobuj za chwile.",
                               retry_after=30)
    finally:
        STATE.queued -= 1

    STATE.in_flight += 1
    try:
        return await _pump(request, client)
    finally:
        STATE.in_flight -= 1
        SEM.release()

# ------------------------------------------------------------------ health loop

async def backend_alive(client: aiohttp.ClientSession) -> bool:
    """Plytki test zywotnosci: backend odpowiada COKOLWIEK na /v1/models (nawet 4xx/5xx) -
    to znaczy ze proces zyje i sluchaj na porcie. Tylko brak polaczenia/timeout = padl."""
    try:
        async with client.get(f"{BACKEND_URL}/v1/models",
                              timeout=aiohttp.ClientTimeout(total=10)) as r:
            await r.read()
    except (aiohttp.ClientError, asyncio.TimeoutError):
        return False
    STATE.last_backend_ok = now()
    return True


async def micro_ping(client: aiohttp.ClientSession) -> bool:
    """Realny mikro-request przez backend - odswieza snapshot limitu. Porazka (np. PING_MODEL
    przestal istniec po stronie OpenAI) NIE restartuje backendu - to za mocna kara za 400."""
    # Quota telemetry is read by Most Monitor. Keep old inference strictly opt-in.
    if os.environ.get('MOST_ALLOW_LEGACY_USAGE_PING') != '1':
        return False
    STATE.last_ping_attempt = now()
    payload = {"model": PING_MODEL, "messages": [{"role": "user", "content": "ping"}],
               "max_tokens": 8, "stream": False}
    try:
        async with client.post(f"{BACKEND_URL}/v1/chat/completions", json=payload,
                               timeout=aiohttp.ClientTimeout(total=90)) as r:
            status = r.status
            await r.read()
    except (aiohttp.ClientError, asyncio.TimeoutError):
        log.warning("mikro-ping na %s: polaczenie nieudane (limit nieodswiezony)", PING_MODEL)
        return False
    if status == 200:
        STATE.last_upstream_ok = now()
        STATE.last_backend_ok = now()
        return True
    log.warning("mikro-ping na %s: HTTP %s (limit nieodswiezony)", PING_MODEL, status)
    return False


def _usage_needs_refresh() -> bool:
    if os.environ.get('MOST_ALLOW_LEGACY_USAGE_PING') != '1':
        return False
    usage = read_usage()
    stale = usage is None or usage["age_s"] > USAGE_REFRESH
    ping_due = now() - STATE.last_ping_attempt >= USAGE_REFRESH
    return stale and ping_due


async def health_loop(app: web.Application) -> None:
    client: aiohttp.ClientSession = app["client"]
    await asyncio.sleep(5)
    while True:
        try:
            if STATE.backend_state != "down":
                if not SUP.alive():
                    log.error("proces ChatMocka zniknal - restart")
                    await SUP.restart("proces padl")
                elif now() - max(STATE.last_backend_ok, STATE.last_upstream_ok, STATE.started_at) > HEALTH_INTERVAL \
                        and STATE.in_flight == 0:
                    alive = await backend_alive(client)
                    if alive:
                        if STATE.backend_state != "ok":
                            STATE.backend_state = "ok"
                    else:
                        log.error("backend nie odpowiada na /v1/models - restart")
                        await SUP.restart("backend nie odpowiada")
                elif STATE.in_flight == 0 and _usage_needs_refresh():
                    await micro_ping(client)
                elif STATE.backend_state == "starting" and STATE.last_backend_ok:
                    STATE.backend_state = "ok"
            _tray_refresh()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("blad petli zdrowia")
        await asyncio.sleep(HEALTH_TICK)

# ------------------------------------------------------------------ tray widget

def tray_thread(loop: asyncio.AbstractEventLoop, stop_event: asyncio.Event) -> None:
    try:
        _tray_body(loop, stop_event)
    except Exception:
        log.exception("tray PADL - most dziala dalej bez ikonki")


def _tray_body(loop: asyncio.AbstractEventLoop, stop_event: asyncio.Event) -> None:
    import pystray
    from PIL import Image, ImageDraw

    COLORS = {"ok": (46, 204, 113), "warn": (241, 196, 15),
              "down": (231, 76, 60), "starting": (149, 165, 166)}

    def make_icon(color) -> "Image.Image":
        img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.ellipse((6, 6, 58, 58), fill=color + (255,))
        d.arc((14, 6, 58, 50), start=210, end=330, fill=(255, 255, 255, 200), width=5)  # "mostek"
        return img

    def visual_state() -> str:
        if STATE.backend_state in ("down",):
            return "down"
        if STATE.backend_state == "starting":
            return "starting"
        usage = read_usage()
        if STATE.backend_state == "suspect":
            return "warn"
        if usage:
            short, weekly = usage["short"], usage["weekly"]
            if (short and short["used_percent"] >= 80) or (weekly and weekly["used_percent"] >= 80):
                return "warn"
        return "ok"

    def tooltip() -> str:
        labels = {"ok": "Most OK", "warn": "Most OK (uwaga)", "down": "Most LEZY",
                  "starting": "Most startuje..."}
        vs = visual_state()
        parts = [labels[vs]]
        usage = read_usage()
        if usage:
            short, weekly = usage["short"], usage["weekly"]
            if short:
                label = f"{short['window_minutes'] // 60}h"
                parts.append(f"{label}: {short['used_percent']:.0f}% (reset {fmt_dur(short['reset_at'] - now())})")
            if weekly:
                parts.append(f"tydz: {weekly['used_percent']:.0f}% (reset {fmt_dur(weekly['reset_at'] - now())})")
            if not short and not weekly:
                parts.append("brak danych o limicie")
            parts.append(f"stan sprzed {fmt_dur(usage['age_s'])}")
        else:
            parts.append("brak danych o limicie")
        if STATE.backend_state == "down" and STATE.restart_reason:
            parts.append(STATE.restart_reason)
        text = " | ".join(parts)
        if eco_mode_on():
            text += " | ECO"
        return text[:127]

    def run_async(coro) -> None:
        asyncio.run_coroutine_threadsafe(coro, loop)

    def on_refresh(icon, item) -> None:
        async def _do():
            try:
                async with app_client().post('http://127.0.0.1:1236/most/v1/refresh',
                        headers={'X-Most-Client': 'local-v1'}, timeout=aiohttp.ClientTimeout(total=45)) as r:
                    await r.read()
                    if r.status >= 400:
                        log.warning('Most Monitor: odswiezenie HTTP %s', r.status)
            except (aiohttp.ClientError, asyncio.TimeoutError):
                log.warning('Most Monitor niedostepny; bez inferencji do odswiezania limitu')
            _tray_refresh()
        run_async(_do())

    def on_restart(icon, item) -> None:
        run_async(SUP.restart("guzik w tray", manual=True))

    def on_logs(icon, item) -> None:
        os.startfile(str(MOST_DIR))

    def autostart_on() -> bool:
        return AUTOSTART_VBS.exists()

    def on_autostart(icon, item) -> None:
        if autostart_on():
            AUTOSTART_VBS.unlink(missing_ok=True)
            log.info("autostart wylaczony (VBS usuniety)")
        else:
            AUTOSTART_VBS.write_text(
                "' Most ChatGPT (PKM Assistant) - autostart. Usuniecie pliku = koniec autostartu.\n"
                f'CreateObject("Wscript.Shell").Run """{PYTHONW}"" ""{MOST_DIR / "most.py"}""", 0, False\n',
                encoding="utf-8")
            log.info("autostart wlaczony (VBS w Starcie)")

    def on_quit(icon, item) -> None:
        icon.stop()
        loop.call_soon_threadsafe(stop_event.set)

    def on_eco(icon, item) -> None:
        set_eco_mode(not eco_mode_on())
        _tray_refresh()

    def status_label(item) -> str:
        return tooltip()

    menu = pystray.Menu(
        pystray.MenuItem(status_label, None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Odswiez limity (Most Monitor)", on_refresh),
        pystray.MenuItem("Restart mostu", on_restart),
        pystray.MenuItem("Otworz logi", on_logs),
        pystray.MenuItem("Autostart z Windows", on_autostart, checked=lambda item: autostart_on()),
        pystray.MenuItem("Tryb oszczedny (Astra -> Sol xhigh)", on_eco, checked=lambda item: eco_mode_on()),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Zamknij most (i ChatMocka)", on_quit),
    )
    icon = pystray.Icon("most_chatgpt", make_icon(COLORS["starting"]), tooltip(), menu)

    def refresh() -> None:
        try:
            icon.icon = make_icon(COLORS[visual_state()])
            icon.title = tooltip()
            icon.update_menu()
        except Exception:
            pass

    global _tray_refresh
    _tray_refresh = refresh
    log.info("tray wystartowal (ikonka przy zegarze)")

    _app_client_holder: list = []

    def app_client() -> aiohttp.ClientSession:
        return _APP["client"]

    icon.run()  # blokuje ten watek do icon.stop()

# ------------------------------------------------------------------ start / stop

_APP: web.Application = None  # type: ignore


async def main() -> int:
    global _APP
    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    app = web.Application(client_max_size=256 * 1024 * 1024)
    _APP = app
    app["client"] = aiohttp.ClientSession(auto_decompress=False)
    app.router.add_get("/most/status", handle_status)
    app.router.add_post("/most/restart", handle_restart)
    app.router.add_post("/most/eco", handle_eco)
    app.router.add_get("/v1/models", handle_models)
    app.router.add_route("*", "/{tail:.*}", handle_proxy)

    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    try:
        site = web.TCPSite(runner, LISTEN_HOST, LISTEN_PORT)
        await site.start()
    except OSError:
        log.error("port %s zajety - most juz dziala? Koncze.", LISTEN_PORT)
        if not NO_TRAY:
            ctypes.windll.user32.MessageBoxW(
                0, f"Port {LISTEN_PORT} jest zajety - most chyba juz dziala.\n"
                   "Sprawdz ikonke przy zegarze albo odpal Restart z pulpitu.",
                "Most ChatGPT", 0x30)
        await app["client"].close()
        return 13

    log.info("most nasluchuje na %s:%s -> backend %s", LISTEN_HOST, LISTEN_PORT, BACKEND_URL)
    SUP.start()

    if not NO_TRAY:
        threading.Thread(target=tray_thread, args=(loop, stop_event), daemon=True,
                         name="tray").start()

    ready = await SUP.wait_ready()
    STATE.backend_state = "ok" if ready else "suspect"
    if not ready:
        log.warning("backend nie wstal w czasie - petla zdrowia bedzie probowac dalej")
    _tray_refresh()

    health = asyncio.create_task(health_loop(app))
    await stop_event.wait()

    log.info("zamykanie mostu...")
    health.cancel()
    SUP.stop()
    await app["client"].close()
    await runner.cleanup()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        SUP.stop()
        sys.exit(0)
