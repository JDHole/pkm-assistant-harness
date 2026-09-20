# Most Monitor

Private subscription telemetry for JDHole OS. A separate Python process reads official Codex app-server quota RPC and Claude Code `/usage`. It never asks a model to measure usage. It does not select models or transfer workflows.

## Contract and sources

See [CONTRACT.md](CONTRACT.md). SQLite and the identity salt live outside the synced vault. Only an anonymous snapshot is exported. The HTTP listener is `127.0.0.1:1236`, requires `X-Most-Client: local-v1`, rejects Origin headers, and enables no CORS. This protects against browser cross-origin requests; local processes of the same user can read the telemetry.

Codex uses `account/read` and `account/rateLimits/read`; every reported bucket/window is separate. This covers Codex/Work, not all ordinary ChatGPT chat quotas. The backend permission `ordinaryUsageAllowed` is preserved independently of percentages. The ChatMock legacy snapshot is not counted as an additional subscription because it lacks an account identity.

Claude 2.1.278 was empirically found to return cached rows even on a failing HTTPS proxy, despite the intended SDK changelog behavior. The collector therefore requires an ordered `fetchUtilization: GET /api/oauth/usage` and `fetchUtilization: 200 after ...` in a unique debug log from the same CLI invocation. The temporary log is deleted; no credentials are copied or replayed. Missing markers fail closed to `unknown/unconfirmed_live_usage`. This diagnostic format is version sensitive. A future CLI change must pass the blocked-network regression probe before becoming the collector runtime.

CLI modes are checked before `/usage`: subscription auth only, safe mode, no tools/MCP/hooks, one builtin local command, zero model turns/cost/tokens, stable account before/after. A pinned isolated official CLI is used so monitoring does not update active user sessions.

## Agents

`python monitor.py usage_status --max-age 60` returns the same snapshot as Home. Optional filters: `--provider`, `--account-ref`, `--host-id`. `history` returns recent samples; `routing_status` explicitly reports `recommend_model` unsupported. CLI talks only to the daemon, without its own collector fallback. It works with Obsidian closed.

Read at task start, before a large delegation, between stages and after a quota error. Ordinary display permits 300s; delegation requests 60s. Inspect each account's status, observation age, reset and `maxAgeSatisfied`. Never infer capacity from unknown/missing values or from a live proxy. The daemon shares concurrent refreshes and applies per-provider backoff. Expired files must be treated as stale even if their serialized status once said fresh. Remote/cloud agents need a delivered snapshot and cannot claim access to laptop localhost.

## Daily change and alerts

Observed increase in each weekly scope, in Europe/Berlin, since its first comparable sample of the day. A reset, usage decrease, account or plan change creates a new segment. Gaps and partial days are explicit. The daily warning is 30 percentage points; 29 does not warn. Separate absolute thresholds are 70/85/95%. An initial 97% sample emits only 95%. Alert identity includes account, pool, scope, segment and daily date where relevant. Restarts retain deduplication. Windows toast submission is recorded separately from a delivery guarantee; errors remain visible in the panel.

## Run and deployment

Python 3.12+ stdlib. A small vendored Europe/Berlin TZif from the installed tzdata 2026.3 distribution supports Windows without system IANA data; licenses are in `zoneinfo/`. Core has no third-party Python imports. The official Claude executable is a separately installed vendor binary, not committed here.

Run `node build_ui.cjs` first. This bundles the UI into one CommonJS file with Obsidian external; the host cannot resolve relative helper modules from a plugin entrypoint. `install_local.py --help` describes explicit local deployment. It preflights the configuration and source set, creates backups, deploys the UI and Home modules, and writes a hidden Windows startup launcher. It never starts or restarts applications. Existing private config backups remain outside the vault. The root operator then starts the monitor and reloads only the Most Status plugin after the gates pass.

The installer registers the local notification identity `JDHole.MostMonitor`. It does not change Windows notification preferences. If Windows returns `DisabledForUser`, the panel reports the block and retains alerts; global notification settings require the user's decision.

Home deployment preserves concurrent work. The installer patches only two cleanup call positions in the current `widgetHome.js`; the checked-in full file is a review fixture, never copied. Unknown lifecycle structure fails preflight. The two Pulpit components must match their recorded pre-monitor baseline or the desired version, otherwise deployment stops before any mutation and requires a merge. A second byte comparison immediately before writing detects changes made after preflight. An already integrated Home requires zero writes.

`legacy/most.py` contains the existing private Most with three localized changes: automatic usage ping disabled by default, explicit `MOST_ALLOW_LEGACY_USAGE_PING=1` compatibility opt-in, and tray refresh calling the read-only monitor. Backend health still uses GET `/v1/models`. Applying that file and restarting the idle bridge is a separate explicit deployment step.

Tests: `python -m unittest discover -v`, `node --test ui/monitor_core.test.js home/pulpit_core.test.js`. Legacy integration tests use Python with the existing aiohttp dependency, fake backend, ports 1244/1245 and a separate base directory; never run them against the live bridge. Private UI files are CommonJS and have their own package boundary.

There is no background model job, external messaging, automatic reset credit purchase, paid API fallback or automatic account switch. Extending providers means adding a collector returning this contract and registering it in the service; the renderer accepts dynamic account/window arrays.
