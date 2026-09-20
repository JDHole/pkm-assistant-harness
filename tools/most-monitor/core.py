"""Persistence and pure snapshot logic for the local Most monitor."""
from __future__ import annotations

import json, math, os, socket, sqlite3, threading, time, uuid, hashlib
from datetime import datetime, timezone, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
    BERLIN = ZoneInfo("Europe/Berlin")
except ZoneInfoNotFoundError:
    # Windows stdlib may lack IANA data. Bundled TZif avoids hand-written DST rules.
    with Path(__file__).with_name('zoneinfo').joinpath('Europe/Berlin').open('rb') as zone:
        BERLIN = ZoneInfo.from_file(zone, key='Europe/Berlin')
WEEK = 10080
THRESHOLDS = (70, 85, 95)

def reset_epoch(value):
    return int(math.floor(value / 60 + .5)) * 60 if isinstance(value, (int, float)) and math.isfinite(value) else None


def _clean(value):
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {str(k): _clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_clean(v) for v in value]
    return value


def _json(value):
    return json.dumps(_clean(value), sort_keys=True, separators=(",", ":"))


def _scope_key(scope):
    return _json(scope if isinstance(scope, dict) else {})


class MonitorCore:
    """Single-process SQLite store. All public methods are lock protected."""
    def __init__(self, data_dir, host_id=None, notifier=None, snapshot_path=None):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.data_dir / "most-monitor.sqlite3"
        self.export_path = self.data_dir / "most-snapshot.json"
        self.snapshot_path = Path(snapshot_path) if snapshot_path else None
        self.host_id = host_id or 'host-' + hashlib.sha256(socket.gethostname().encode()).hexdigest()[:16]
        self.notifier = notifier
        self.lock = threading.RLock()
        self.delivery_lock = threading.Lock()
        self.db = sqlite3.connect(str(self.path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS samples (
            provider TEXT, account_ref TEXT, pool_id TEXT, window_id TEXT, scope TEXT,
            plan TEXT, reset_epoch INTEGER, observed_at REAL, received_at REAL, value REAL,
            window_minutes INTEGER, status TEXT, segment TEXT);
          CREATE INDEX IF NOT EXISTS sample_lookup ON samples(provider,account_ref,window_id,received_at);
          CREATE INDEX IF NOT EXISTS sample_segment ON samples(segment,observed_at);
          CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, dedup TEXT UNIQUE, payload TEXT, created_at REAL, delivered INTEGER);
        """)
        self.db.commit()

    def close(self):
        with self.delivery_lock, self.lock:
            self.db.close()

    def _load_raw(self):
        row = self.db.execute("SELECT value FROM state WHERE key='snapshot'").fetchone()
        return json.loads(row[0]) if row else None

    def _save_raw(self, snapshot):
        self.db.execute("INSERT OR REPLACE INTO state(key,value) VALUES('snapshot',?)", (_json(snapshot),))

    @staticmethod
    def _valid_number(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)

    def _materialize_account(self, account, now):
        a = _clean(dict(account))
        status = a.get("status", "unknown")
        valid = a.get("validUntil")
        observed = a.get("observedAt")
        expired = self._valid_number(valid) and now >= valid
        # A window has an actual reset in the past: it cannot be shown as current.
        reset_expired = any(self._valid_number(w.get("resetsAt")) and now >= w["resetsAt"]
                            for w in a.get("windows", []) if isinstance(w, dict))
        if status == 'fresh' and (not self._valid_number(valid) or not self._valid_number(observed) or observed > now + 5):
            a.update(status='unknown', reason='unconfirmed_observation')
        elif status == "fresh" and (expired or reset_expired or now >= observed + 300):
            a["status"] = "stale"
            a["reason"] = "expired" if expired else "window_reset_due"
        return a

    def _daily(self, account, now):
        observed = account.get('observedAt')
        if not self._valid_number(observed): return []
        local = datetime.fromtimestamp(observed, BERLIN).replace(hour=0, minute=0, second=0, microsecond=0)
        day = local.date().isoformat()
        out = []
        for w in account.get("windows", []):
            if not isinstance(w, dict) or w.get("windowMinutes") != WEEK or not self._valid_number(w.get("usedPercent")):
                continue
            if not w.get('segmentId'): continue
            scope = _scope_key(w.get("scope", {})); reset = w.get("resetsAt")
            rows = self.db.execute("""SELECT * FROM samples WHERE provider=? AND account_ref=? AND pool_id=? AND window_id=? AND scope=?
              AND status='fresh' AND window_minutes=? AND segment=? AND observed_at>=? AND observed_at<? ORDER BY observed_at""",
              (account.get("provider"), account.get("accountRef"), w.get("poolId"), w.get("windowId"), scope, WEEK, w['segmentId'], local.timestamp(), (local + timedelta(days=1)).timestamp())).fetchall()
            segment = []
            for r in rows:
                if datetime.fromtimestamp(r["observed_at"], timezone.utc).astimezone(BERLIN).date().isoformat() != day: continue
                # Plan/reset changes begin a distinct comparable segment.
                if r["plan"] != account.get("plan") or r["reset_epoch"] != reset_epoch(reset):
                    continue
                if segment and r["value"] < segment[-1]["value"]:
                    segment = []
                segment.append(r)
            current = float(w["usedPercent"])
            if segment and current < segment[-1]["value"]:
                segment = []
            if segment:
                base = segment[0]; delta = max(0.0, current - base["value"])
                gap = any(b["observed_at"] - a["observed_at"] > 600 for a, b in zip(segment, segment[1:]))
                if now - segment[-1]["observed_at"] > 600: gap = True
                baseline_at = base["observed_at"]
            else:
                delta, gap, baseline_at = 0.0, False, now
            out.append({"poolId": w.get("poolId"), "windowId": w.get("windowId"), "scope": w.get("scope", {}),
              "date": day, "epoch": w['segmentId'],
              "baselineAt": baseline_at, "deltaPp": delta, "partial": True, "hasGap": gap})
        return out

    def _segment(self, a, w):
        key = 'segment:' + _json([a['provider'], a['accountRef'], w['poolId'], w['windowId'], w.get('scope', {})])
        row = self.db.execute('SELECT value FROM state WHERE key=?', (key,)).fetchone()
        s = json.loads(row[0]) if row else None
        epoch = reset_epoch(w.get('resetsAt')); value = w['usedPercent']; observed = a['observedAt']
        if not s or s['plan'] != a.get('plan') or s['epoch'] != epoch or value < s['value']:
            s = dict(id=str(uuid.uuid4()), plan=a.get('plan'), epoch=epoch, value=value, observedAt=None)
        duplicate = s['observedAt'] is not None and observed <= s['observedAt']
        if not duplicate: s.update(value=value, observedAt=observed)
        self.db.execute('INSERT OR REPLACE INTO state VALUES(?,?)', (key, _json(s)))
        return s['id'], duplicate

    def ingest(self, accounts, now=None):
        """Persist a successful collector round. Error accounts inherit prior windows."""
        now = float(time.time() if now is None else now)
        with self.lock:
            old = self._load_raw() or {"accounts": []}
            old_by = {(a.get("provider"), a.get("accountRef")): a for a in old.get("accounts", [])}
            result = []
            for incoming in accounts:
                a = _clean(dict(incoming)); key = (a.get("provider"), a.get("accountRef"))
                prior = old_by.get(key)
                if not prior and str(a.get('accountRef', '')).endswith('-unknown'):
                    prior = next((x for x in old.get('accounts', []) if x.get('provider') == a.get('provider')), None)
                if a.get("status") in ("error", "auth_required", "unsupported", "unknown") and prior:
                    for k in ("accountRef", "windows", "observedAt", "validUntil", "plan", "coverage", "authMode"):
                        if k in prior: a[k] = prior[k]
                a.setdefault("receivedAt", now); a.setdefault("windows", []); a.setdefault("coverage", [])
                a = self._materialize_account(a, now)
                # Store valid samples only. reset is minute normalized.
                for w in a["windows"]:
                    if a.get("status") == "fresh" and self._valid_number(w.get("usedPercent")):
                        reset = w.get("resetsAt")
                        segment, duplicate = self._segment(a, w); w['segmentId'] = segment
                        if not duplicate:
                            self.db.execute("INSERT INTO samples VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (a.get("provider"), a.get("accountRef"), w.get("poolId"), w.get("windowId"), _scope_key(w.get("scope", {})), a.get("plan"), reset_epoch(reset), a.get("observedAt"), now, w["usedPercent"], w.get("windowMinutes"), a.get("status"), segment))
                a["daily"] = self._daily(a, now)
                result.append(a)
            snapshot = {"schemaVersion": 1, "snapshotId": str(uuid.uuid4()), "hostId": self.host_id,
              "collectorVersion": "1.0.0", "receivedAt": now,
              "validUntil": min((a.get("validUntil") for a in result if self._valid_number(a.get("validUntil"))), default=None),
              "status": "fresh" if any(a.get("status") == "fresh" for a in result) else "error",
              "accounts": result, "alerts": [], "notificationStatus": "not_configured"}
            snapshot["alerts"] = self._new_alerts(snapshot, now)
            snapshot["alerts"] += self._recent_alerts()
            snapshot["alerts"] = self._dedupe_alerts(snapshot["alerts"])
            self._summarize(snapshot); self._save_raw(snapshot); self.db.commit(); self._export(snapshot)
            return snapshot

    def _dedupe_alerts(self, alerts):
        seen = set(); return [a for a in alerts if not (a["id"] in seen or seen.add(a["id"]))]

    def _new_alerts(self, snapshot, now):
        new = []
        for a in snapshot["accounts"]:
            if a.get("status") != "fresh": continue
            for w in a.get("windows", []):
                v = w.get("usedPercent")
                if not self._valid_number(v): continue
                levels = [t for t in THRESHOLDS if v >= t]
                if levels: new.append(self._alert(a, w, "window", max(levels), v, now))
            for d in a.get("daily", []):
                if d["deltaPp"] >= 30: new.append(self._alert(a, d, "daily", 30, d["deltaPp"], now))
        accepted=[]
        for alert in new:
            prefix = [alert[k] for k in ('kind','provider','accountRef','poolId','windowId','scope','epoch')]
            if any(self.db.execute('SELECT 1 FROM alerts WHERE dedup=?', (_json(prefix + [level]),)).fetchone() for level in (THRESHOLDS if alert['kind'] == 'window' else (30,)) if level >= alert['threshold']): continue
            dedup = _json(prefix + [alert['threshold']])
            try:
                self.db.execute("INSERT INTO alerts VALUES(?,?,?,?,?)", (alert["id"], dedup, _json(alert), now, 0 if self.notifier else -2)); accepted.append(alert)
            except sqlite3.IntegrityError: pass
        return accepted

    def deliver_pending(self):
        if not self.notifier: return
        with self.delivery_lock:
            with self.lock: pending = list(self.db.execute('SELECT id,payload FROM alerts WHERE delivered=0 ORDER BY created_at'))
            for row in pending:
                with self.lock:
                    self.db.execute('UPDATE alerts SET delivered=-3 WHERE id=?', (row['id'],)); self.db.commit()
                try: ok = self.notifier.notify(json.loads(row['payload']))
                except Exception: ok = False
                with self.lock:
                    self.db.execute('UPDATE alerts SET delivered=? WHERE id=?', (1 if ok else -1, row['id'])); self.db.commit()
                    s = self.snapshot()
                    if s: self._export(s)

    def _summarize(self, s):
        states = [a.get('status') for a in s['accounts']]
        s['status'] = 'fresh' if states and all(x == 'fresh' for x in states) else 'partial' if 'fresh' in states else 'stale' if 'stale' in states else 'error'
        delivery = [r[0] for r in self.db.execute('SELECT delivered FROM alerts ORDER BY created_at DESC LIMIT 100')]
        s['notificationStatus'] = 'error' if -1 in delivery or -3 in delivery else 'pending' if 0 in delivery else 'submitted' if 1 in delivery else 'disabled' if not self.notifier else 'none'
        s['notificationReason'] = getattr(self.notifier, 'LAST_STATUS', None)

    def _alert(self, a, w, kind, threshold, value, now):
        epoch = [w.get('date'), w.get('epoch')] if kind == 'daily' else w.get('segmentId')
        label = a.get('label', a['provider']) + ' / ' + w.get('label', w.get('windowId', 'okno'))
        message = f'{label}: od startu pomiarów dnia przybyło {value:g} p.p. (próg {threshold}).' if kind == 'daily' else f'{label}: wykorzystano {value:g}% (próg {threshold}%).'
        return {"id": str(uuid.uuid4()), "kind": kind, "provider": a.get("provider"), "accountRef": a.get("accountRef"), "poolId": w.get("poolId"), "windowId": w.get("windowId"), "scope": w.get("scope", {}), "threshold": threshold, "value": value, "createdAt": now, "epoch": epoch, "message": message}

    def _recent_alerts(self):
        return [json.loads(r[0]) for r in self.db.execute("SELECT payload FROM alerts ORDER BY created_at DESC LIMIT 100")]

    def _export(self, snapshot):
        for path in [self.export_path] + ([self.snapshot_path] if self.snapshot_path else []):
            path.parent.mkdir(parents=True, exist_ok=True)
            temp = path.with_name(path.name + '.tmp')
            with temp.open('w', encoding='utf-8') as f:
                f.write(_json(snapshot)); f.flush(); os.fsync(f.fileno())
            os.replace(temp, path)

    def snapshot(self, now=None, provider=None, account_ref=None, host_id=None):
        now = float(time.time() if now is None else now)
        with self.lock:
            s = self._load_raw()
            if not s: return None
            if host_id and host_id != self.host_id: raise ValueError("hostId mismatch")
            s = _clean(s); s["accounts"] = [self._materialize_account(a, now) for a in s.get("accounts", [])]
            for a in s["accounts"]: a["daily"] = self._daily(a, now)
            if provider: s["accounts"] = [a for a in s["accounts"] if a.get("provider") == provider]
            if account_ref: s["accounts"] = [a for a in s["accounts"] if a.get("accountRef") == account_ref]
            self._summarize(s)
            return s

    def history(self, limit=200):
        limit = max(1, min(int(limit), 200))
        with self.lock:
            return [dict(r) for r in self.db.execute("SELECT * FROM samples ORDER BY received_at DESC LIMIT ?", (limit,))]
