# Graf v1

Graf is a bounded, durable coordinator for native coding-agent handoffs. It does not invent an agent API and it never runs a returned command or agent itself. The caller invokes the returned native `collaboration.spawn_agent` action, then records the real receipt and result.

Use a JSON file so prompts and paths are not interpreted by a shell:

```powershell
node tools/graf/cli.mjs prepare --request C:/safe/graf-request.json
node tools/graf/cli.mjs next --request C:/safe/graf-next.json
node tools/graf/cli.mjs dispatch --request C:/safe/graf-dispatch.json
node tools/graf/cli.mjs ack --request C:/safe/graf-ack.json
node tools/graf/cli.mjs record --request C:/safe/graf-result.json
node tools/graf/cli.mjs reconcile --request C:/safe/graf-reconcile.json
node tools/graf/cli.mjs retry --request C:/safe/graf-retry.json
node tools/graf/cli.mjs report --request C:/safe/graf-run.json
```

`examples/smoke-request.json` is generic. Set `data_root` to a durable caller-owned directory outside this public repository. Its test and review nodes use `write_scope:"none"`/`"read-only"`; their evidence paths may point outside the target repository and Graf copies verified snapshots into `data_root`. Every invocation reloads `runs/<run_id>/manifest.json`, `events.jsonl`, and `checkpoint.json`. The journal has canonical hashes and file fsyncs. A log tail written before its checkpoint fails closed until a caller explicitly sets `safe_checkpoint_catchup:true`; malformed and truncated logs are preserved. Files are fsynced before atomic rename. Windows does not expose a portable directory-handle fsync here, so the renamed directory entry itself cannot receive the additional POSIX directory fsync used on other platforms; checkpoint verification remains the recovery guard.

Short-lived mutation locks do not live in `data_root`: Graf derives a deterministic name from the canonical run/results directory and holds a `BEGIN IMMEDIATE` transaction in a separate SQLite database under the host's local `os.tmpdir()/graf-v1-locks` for the complete mutation callback. A competing transaction fails with `LOCKED`, while process death makes SQLite release the operating-system lock without PID eviction or stale-file deletion. The database must remain on host-local storage. This avoids synced-filesystem implementations where recursive delete reports success while the directory name remains occupied. Durable manifests, events, checkpoints, packets, evidence, reports, and writer reservations remain in caller storage. A terminal writer releases its durable active reservation by atomic rename to a unique `.released-*` history file; it does not rely on immediate unlink semantics from a synced filesystem.

`prepare` requires task, acceptance criteria, repository/base commit, a bounded DAG, and `context.max_input_bytes`. It verifies that `base_commit` resolves to a Git commit and records the prepared HEAD separately. A deliberately nongit test fixture must set `allow_unverified_base_commit:true`; the manifest and report then say `unverified` and retain the reason. Context packets always include task/acceptance, tracked node inputs, and applicable ancestor `AGENTS.md`/`CLAUDE.md`; explicitly listed mandatory files cannot be trimmed. The hard byte gate measures the complete final `native_action.args.message` with `Buffer.byteLength(..., "utf8")`, including wrappers, goal, scope, schema, and sources. Candidate and selected-final sizes use the same method. The separately reported UTF-8-bytes/3 token value remains an estimate.

`dispatch` writes intent before returning an action. Its `native_action.args` directly match Codex `collaboration.spawn_agent`: `task_name`, `message`, `model`, `reasoning_effort`, and `fork_turns:"none"`. `ack` requires a real `tool_agent_id`. Unknown or running native work is never replayed by `resume`; the caller gets a `reconcile` or `cancellation_required` action. A write-scope node reserves one canonical repository tree across Graf runs until a terminal result or explicit reconciliation is recorded. Two native agents can run concurrently only when their resources allow it.

A writer must predeclare exact repository-relative `write_paths`, each inside its canonical `write_scope`. The durable intent snapshots every allowed path before execution. `record` and `reconcile` use this shape and must cover exactly the paths that really changed:

```json
{
  "effects": [{
    "path": "src/example.js",
    "before": {"exists": true, "sha256": "<64 lowercase hex>"},
    "after": {"exists": true, "sha256": "<64 lowercase hex>"}
  }]
}
```

Graf checks `before` against the durable attempt baseline, `after` against the current file, and the path against the prepared allowlist. Accepted effects append `effect_applied`, advance the event-sourced current hashes, and create a fresh source packet for downstream nodes. `baseline_input_hashes` in the manifest never changes. Undeclared paths, incomplete effect sets, changed instructions, and other unexpected input drift remain quarantined.

`record passed` requires evidence file hashes and snapshots them under the run. A review node with `reviewer_for` must report a different executor identity than its implementation node. Changed source hashes invalidate passed affected nodes and descendants. A running node with unexpected input drift stays quarantined and retains its writer reservation.

`reconcile` is the only recovery operation for a durable `unknown` or `running` attempt whose real native state is known. It requires `effect_checked:true`, nonempty `reconciliation_evidence`, any verified partial `effects`, and a terminal `status` of `failed`, `blocked`, `cancelled`, or `timeout`. It does not invent an ack, mark work passed, or replay the native action. After reconciliation releases the writer reservation, a separate bounded `retry` may create the next numbered attempt.

Retry is explicit: `retry` accepts only a terminal failed/blocked/cancelled/timeout attempt and requires `effect_checked:true` with reconciliation evidence before it returns a node to `pending`. Graf v1 intentionally sends only TypeSafe **Choice** questions for context ranking and delegation. Score and Noul are not part of this bounded version.

`decide` uses the documented direct TypeSafe endpoint with a pinned `jev-1.13.0` model, redirect refusal, timeout, strict answer validation, semantic cache keys, and no provider error body logging. Real calls are disabled without `paid_api_enabled:true`, a positive caller-approved API budget, and an API key. Before releasing the filesystem lock and making a paid request, Graf appends `decision_intent`; concurrent calls therefore reserve the bounded call budget exactly once. A crash after this intent remains an unknown paid attempt with unavailable usage in `resume`/`report`, still consumes the limit, and is never automatically replayed. Graf v1 is intentionally **off/shadow-only**: shadow records a proposal but applies rules, and active is rejected rather than pretended. Official documentation pinned on 2026-09-22: <https://docs.typesafe.ai/api>.

The module is dependency-free and tested with Node's built-in runner:

```powershell
node --test tools/graf/*.test.mjs
```

Limits are two concurrent agents, eight starts, thirty decision calls, thirty minutes, and two repair rounds. `report` writes `report.md` per run plus stable `results/index.md`, preserving existing index prose around Graf-managed blocks.
