/**
 * Graf v1 is a durable coordinator. It never launches an agent or a shell:
 * callers execute returned native actions and send back a receipt.
 */
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export const VERSION = '1.0.0';
export const SCHEMA_VERSION = 1;
const EVENT_FILE = 'events.jsonl';
const MANIFEST_FILE = 'manifest.json';
const CHECKPOINT_FILE = 'checkpoint.json';
const TERMINAL = new Set(['passed', 'failed', 'blocked', 'cancelled', 'timeout', 'skipped', 'invalidated']);
const NODE_STATES = new Set(['pending', 'unknown', 'running', ...TERMINAL]);

export class GrafError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'GrafError'; this.code = code; this.details = details; }
}
const fail = (code, message, details) => { throw new GrafError(code, message, details); };
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function cleanId(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(value)) fail('INVALID_ID', `${name} must be a stable safe identifier`);
  return value;
}
function requiredString(value, name) { if (typeof value !== 'string' || !value.trim()) fail('INVALID_REQUEST', `${name} is required`); return value; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { fail('CORRUPT_JSON', `Cannot read ${path.basename(file)}`, {file, cause: error.message}); } }
function safeRelative(root, candidate) {
  const resolved = path.resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) fail('UNSAFE_PATH', 'Path escapes its allowed root', {candidate});
  return resolved;
}
function fsyncFile(file, data) { const fd = fs.openSync(file, 'w'); try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function atomicJson(file, object) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), {recursive: true}); fsyncFile(tmp, `${JSON.stringify(object, null, 2)}\n`); fs.renameSync(tmp, file);
  // Windows does not permit fsync on a directory handle. The payload is fsynced
  // before an atomic rename; checkpoint verification remains the crash guard.
  if (process.platform !== 'win32') { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
}
function atomicText(file, content) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; fs.mkdirSync(path.dirname(file), {recursive: true}); fsyncFile(tmp, content); fs.renameSync(tmp, file);
  if (process.platform !== 'win32') { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
}
function appendFsync(file, line) { fs.mkdirSync(path.dirname(file), {recursive: true}); const fd = fs.openSync(file, 'a'); try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function runDir(dataRoot, runId) { return safeRelative(path.resolve(requiredString(dataRoot, 'data_root')), path.join('runs', cleanId(runId, 'run_id'))); }
function resultsDir(dataRoot) { return safeRelative(path.resolve(requiredString(dataRoot, 'data_root')), 'results'); }
function repoIdentity(repo) { return fs.realpathSync.native(path.resolve(repo)); }
function writerReservation(dataRoot, repo) { return path.join(path.resolve(dataRoot), 'writer-reservations', `${sha256(repoIdentity(repo))}.json`); }
function manifestFile(dataRoot, runId) { return path.join(runDir(dataRoot, runId), MANIFEST_FILE); }
function manifestDigest(manifest) { const clone = structuredClone(manifest); delete clone.integrity_hash; return sha256(canonical(clone)); }
function sourceHash(file) { return sha256(fs.readFileSync(file)); }
function logicalRepoPath(repo, candidate, name = 'path') {
  const raw = requiredString(candidate, name);
  const full = path.isAbsolute(raw) ? path.resolve(raw) : safeRelative(path.resolve(repo), raw);
  const relative = path.relative(path.resolve(repo), full);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('UNSAFE_PATH', `${name} must name a file inside the repository`, {path: raw});
  return {path: relative.replaceAll('\\', '/'), full};
}
function fileState(file) {
  if (!fs.existsSync(file)) return {exists: false, sha256: null};
  if (!fs.statSync(file).isFile()) fail('INVALID_EFFECT_PATH', 'Tracked path is not a regular file', {path: file});
  return {exists: true, sha256: sourceHash(file)};
}
function normalizedRef(repo, ref, {allowMissing = false, allowExternal = false} = {}) {
  const normalized = path.isAbsolute(ref.path) && allowExternal ? {path: path.resolve(ref.path).replaceAll('\\', '/'), full: path.resolve(ref.path)} : logicalRepoPath(repo, ref.path, 'input ref path');
  const state = fileState(normalized.full);
  if (!state.exists && !allowMissing) fail('MISSING_INPUT', 'Referenced input is missing', {path: ref.path});
  return {path: normalized.path, ...state};
}
function sameFileState(left, right) { return !!left && !!right && left.exists === right.exists && (left.sha256 ?? null) === (right.sha256 ?? null); }
function gitOutput(repo, args) {
  try { return execFileSync('git', ['-c', `safe.directory=${repo}`, '-C', repo, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim(); }
  catch (error) { return {error: String(error.stderr || error.message).trim()}; }
}
function verifyBaseCommit(repo, baseCommit, allowUnverified) {
  const inside = gitOutput(repo, ['rev-parse', '--is-inside-work-tree']);
  if (typeof inside !== 'string' || inside !== 'true') {
    if (!allowUnverified) fail('BASE_COMMIT_UNVERIFIED', 'repo is not a verified Git work tree; tests must opt into unverified provenance explicitly', {reason: inside.error || 'not_a_git_work_tree'});
    return {status: 'unverified', reason: inside.error || 'not_a_git_work_tree', requested_base: baseCommit, resolved_base: null, prepared_head: null};
  }
  const resolved = gitOutput(repo, ['rev-parse', '--verify', `${baseCommit}^{commit}`]);
  const head = gitOutput(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (typeof resolved !== 'string' || typeof head !== 'string') {
    const reason = typeof resolved === 'string' ? head.error : resolved.error;
    if (!allowUnverified) fail('BASE_COMMIT_UNVERIFIED', 'base_commit does not resolve to a Git commit', {base_commit: baseCommit, reason});
    return {status: 'unverified', reason, requested_base: baseCommit, resolved_base: typeof resolved === 'string' ? resolved : null, prepared_head: typeof head === 'string' ? head : null};
  }
  return {status: 'verified', reason: null, requested_base: baseCommit, resolved_base: resolved, prepared_head: head};
}
function provenanceDrift(manifest) {
  if (manifest.base_provenance?.status !== 'verified') return null;
  const head = gitOutput(manifest.repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const resolved = gitOutput(manifest.repo, ['rev-parse', '--verify', `${manifest.base_commit}^{commit}`]);
  if (typeof head !== 'string' || typeof resolved !== 'string') return {reason: 'git_provenance_unreadable', current_head: typeof head === 'string' ? head : null, current_base: typeof resolved === 'string' ? resolved : null};
  if (head !== manifest.base_provenance.prepared_head || resolved !== manifest.base_provenance.resolved_base) return {reason: 'git_ref_or_head_changed', prepared_head: manifest.base_provenance.prepared_head, current_head: head, prepared_base: manifest.base_provenance.resolved_base, current_base: resolved};
  return null;
}
function nodeWritePaths(manifest, node) {
  if (!isWriter(node)) return [];
  const requestedScope = node.write_scope === 'repo' ? path.resolve(manifest.repo) : path.isAbsolute(node.write_scope) ? path.resolve(node.write_scope) : safeRelative(path.resolve(manifest.repo), node.write_scope);
  const repoRoot = path.resolve(manifest.repo); if (requestedScope !== repoRoot && !requestedScope.startsWith(`${repoRoot}${path.sep}`)) fail('WRITE_SCOPE_OUTSIDE_REPO', 'write_scope must stay inside the canonical repository', {node_id: node.node_id, write_scope: node.write_scope});
  const scope = requestedScope;
  return node.write_paths.map(item => {
    const normalized = logicalRepoPath(manifest.repo, item, 'write_paths item');
    if (normalized.full !== scope && !normalized.full.startsWith(`${scope}${path.sep}`)) fail('WRITE_PATH_OUT_OF_SCOPE', 'write_paths item escapes node.write_scope', {node_id: node.node_id, path: item, write_scope: node.write_scope});
    return normalized;
  });
}

export function validateManifest(manifest) {
  if (!manifest || manifest.schema_version !== SCHEMA_VERSION) fail('INVALID_MANIFEST', 'Unsupported manifest schema');
  cleanId(manifest.run_id, 'run_id'); requiredString(manifest.task_text, 'task_text');
  if (!Array.isArray(manifest.acceptance_criteria) || !manifest.acceptance_criteria.length) fail('INVALID_MANIFEST', 'Acceptance criteria are required');
  if (!['B', 'C'].includes(manifest.variant)) fail('INVALID_MANIFEST', 'variant must be B or C');
  if (!['off', 'shadow'].includes(manifest.decision_mode)) fail('ACTIVE_UNSUPPORTED', 'Graf v1 is intentionally off/shadow-only; active decisions are not implemented');
  const budget = manifest.budget || {};
  for (const [key, limit] of Object.entries({max_concurrent: 2, max_agent_starts: 8, max_decision_calls: 30, max_minutes: 30, max_repair_rounds: 2})) {
    if (!Number.isInteger(budget[key]) || budget[key] < 0 || budget[key] > limit) fail('INVALID_BUDGET', `${key} exceeds Graf v1 bound`);
  }
  if (!Array.isArray(manifest.nodes) || !manifest.nodes.length) fail('INVALID_MANIFEST', 'At least one node is required');
  const ids = new Set();
  for (const node of manifest.nodes) {
    cleanId(node.node_id, 'node_id'); if (ids.has(node.node_id)) fail('DUPLICATE_NODE', 'Duplicate node id', {node_id: node.node_id}); ids.add(node.node_id);
    requiredString(node.goal, `goal for ${node.node_id}`); if (!Array.isArray(node.acceptance) || !node.acceptance.length) fail('MISSING_ACCEPTANCE', 'Every node needs acceptance', {node_id: node.node_id});
    if (!Array.isArray(node.depends_on)) fail('INVALID_NODE', 'depends_on must be an array', {node_id: node.node_id});
    if (!Number.isInteger(node.max_attempts) || node.max_attempts < 1) fail('INVALID_NODE', 'max_attempts must be positive', {node_id: node.node_id});
    if (!Number.isInteger(node.timeout_seconds) || node.timeout_seconds < 1) fail('INVALID_NODE', 'timeout_seconds must be positive', {node_id: node.node_id});
    if (!node.output_contract || typeof node.output_contract !== 'object') fail('INVALID_NODE', 'output_contract is required', {node_id: node.node_id});
    if (isWriter(node)) {
      if (!Array.isArray(node.write_paths) || !node.write_paths.length) fail('MISSING_WRITE_PATHS', 'Every writer must predeclare a non-empty write_paths allowlist', {node_id: node.node_id});
      const normalized = nodeWritePaths(manifest, node).map(item => item.path);
      if (new Set(normalized).size !== normalized.length) fail('DUPLICATE_WRITE_PATH', 'write_paths must not contain duplicates', {node_id: node.node_id});
    } else if (node.write_paths !== undefined && (!Array.isArray(node.write_paths) || node.write_paths.length)) fail('INVALID_NODE', 'Read-only nodes cannot declare write_paths', {node_id: node.node_id});
  }
  for (const node of manifest.nodes) for (const dep of node.depends_on) if (!ids.has(dep)) fail('MISSING_DEPENDENCY', 'Dependency does not exist', {node_id: node.node_id, dependency: dep});
  const visiting = new Set(), visited = new Set();
  const visit = id => { if (visiting.has(id)) fail('CYCLE', 'Plan dependencies contain a cycle', {node_id: id}); if (visited.has(id)) return; visiting.add(id); const node = manifest.nodes.find(n => n.node_id === id); node.depends_on.forEach(visit); visiting.delete(id); visited.add(id); };
  manifest.nodes.forEach(n => visit(n.node_id));
  if (manifest.integrity_hash && manifest.integrity_hash !== manifestDigest(manifest)) fail('MANIFEST_TAMPERED', 'Manifest integrity hash does not match');
  return manifest;
}

function acquireLock(dir) {
  fs.mkdirSync(dir, {recursive: true});
  const target = fs.realpathSync.native(path.resolve(dir));
  const lockRoot = path.join(os.tmpdir(), 'graf-v1-locks');
  fs.mkdirSync(lockRoot, {recursive: true});
  const lock = path.join(lockRoot, `${sha256(process.platform === 'win32' ? target.toLowerCase() : target)}.sqlite`);
  const database = new DatabaseSync(lock);
  try {
    database.exec('PRAGMA busy_timeout = 0');
    database.exec('BEGIN IMMEDIATE');
  } catch (error) {
    try { database.close(); } catch {}
    if (error?.errcode === 5) fail('LOCKED', 'Another Graf mutation holds the local SQLite transaction', {run_dir: dir, lock});
    throw error;
  }
  return () => {
    let releaseError = null;
    try { database.exec('ROLLBACK'); } catch (error) { releaseError = error; }
    try { database.close(); } catch (error) { releaseError ||= error; }
    if (releaseError) fail('LOCK_RELEASE_FAILED', 'Local SQLite mutation transaction could not be released', {run_dir: dir, lock, cause: releaseError.message});
  };
}
function withLock(dataRoot, runId, fn) { const dir = runDir(dataRoot, runId); const release = acquireLock(dir); try { return fn(dir); } finally { release(); } }

function readEvents(dir) {
  const file = path.join(dir, EVENT_FILE); if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8'); if (raw === '') return []; if (!raw.endsWith('\n')) fail('TORN_LOG', 'Event log has an incomplete tail', {file});
  const lines = raw.split('\n'); lines.pop(); let prev = null;
  return lines.map((line, index) => {
    let event; try { event = JSON.parse(line); } catch { fail('TORN_LOG', 'Event log contains invalid JSON', {line: index + 1}); }
    if (event.seq !== index + 1 || event.prev_hash !== prev) fail('CORRUPT_LOG', 'Event sequence or hash chain is invalid', {line: index + 1});
    const clone = structuredClone(event); const hash = clone.hash; delete clone.hash;
    if (hash !== sha256(canonical(clone))) fail('CORRUPT_LOG', 'Event hash is invalid', {line: index + 1}); prev = hash; return event;
  });
}
function checkpoint(dir, events, {allowCatchup = false} = {}) {
  const file = path.join(dir, CHECKPOINT_FILE); const cp = fs.existsSync(file) ? readJson(file) : {seq: 0, hash: null};
  if (!Number.isInteger(cp.seq) || cp.seq < 0) fail('CORRUPT_CHECKPOINT', 'Invalid checkpoint');
  if (events.length < cp.seq) fail('TRUNCATED_LOG', 'Event log is shorter than acknowledged checkpoint', {checkpoint: cp.seq, found: events.length});
  const acknowledged = cp.seq === 0 ? null : events[cp.seq - 1]?.hash;
  if (acknowledged !== cp.hash) fail('CORRUPT_CHECKPOINT', 'Checkpoint hash does not match log', {checkpoint: cp.seq});
  if (events.length > cp.seq) {
    if (!allowCatchup) fail('CHECKPOINT_CATCHUP_REQUIRED', 'Durably written events exceed checkpoint; inspect and request explicit safe catchup', {checkpoint: cp.seq, durable_events: events.length});
    atomicJson(file, {seq: events.length, hash: events.at(-1).hash, caught_up_at: now(), reason: 'explicit_safe_catchup'});
  }
  return {seq: events.length, hash: events.at(-1)?.hash ?? null};
}
function appendEvent(dir, input) {
  const events = readEvents(dir); checkpoint(dir, events); const prev = events.at(-1)?.hash ?? null;
  const manifest = fs.existsSync(path.join(dir, MANIFEST_FILE)) ? readJson(path.join(dir, MANIFEST_FILE)) : null;
  const event = {event_id: crypto.randomUUID(), seq: events.length + 1, prev_hash: prev, at: now(), run_id: input.run_id ?? manifest?.run_id ?? null, node_id: input.node_id ?? null, attempt_id: input.attempt_id ?? null, source: input.source ?? 'graf-cli', ...input};
  event.hash = sha256(canonical(event)); appendFsync(path.join(dir, EVENT_FILE), `${JSON.stringify(event)}\n`);
  atomicJson(path.join(dir, CHECKPOINT_FILE), {seq: event.seq, hash: event.hash, acknowledged_at: now()}); return event;
}

function loadRun(dataRoot, runId, options = {}) {
  const dir = runDir(dataRoot, runId), file = path.join(dir, MANIFEST_FILE); if (!fs.existsSync(file)) fail('RUN_NOT_FOUND', 'Run manifest was not found', {run_id: runId});
  const manifest = validateManifest(readJson(file)); const events = readEvents(dir); checkpoint(dir, events, options); return {dir, manifest, events};
}
function deriveState(manifest, events) {
  const state = Object.fromEntries(manifest.nodes.map(n => [n.node_id, {status: 'pending', attempts: [], evidence: [], executor_identity: null, invalid_reason: null}]));
  const receiptIds = new Map(), usageIds = new Map();
  for (const event of events) {
    if (event.type === 'usage' && event.payload?.usage_id) { const prior = usageIds.get(event.payload.usage_id); if (prior && canonical(prior) !== canonical(event.payload)) fail('USAGE_ID_CONFLICT', 'A usage_id maps to conflicting durable telemetry', {usage_id: event.payload.usage_id}); usageIds.set(event.payload.usage_id, event.payload); }
    const node = event.node_id && state[event.node_id]; if (!node) continue;
    if (event.type === 'attempt_intent') { node.attempts.push({attempt_id: event.attempt_id, operation_id: event.payload?.operation_id, expected_effects: event.payload?.expected_effects ?? [], status: 'unknown', identity: event.payload?.executor_identity ?? null, started_at: event.at}); node.status = 'unknown'; }
    if (event.type === 'attempt_receipt') { const a = node.attempts.find(x => x.attempt_id === event.attempt_id); if (a) { a.status = 'running'; a.tool_agent_id = event.payload.tool_agent_id; a.identity = event.payload.tool_agent_id; a.receipt_id = event.payload.receipt_id; } receiptIds.set(event.payload.receipt_id, {node_id: event.node_id, attempt_id: event.attempt_id, tool_agent_id: event.payload.tool_agent_id}); node.status = 'running'; }
    if (event.type === 'node_result') { node.status = event.payload.status; node.evidence = event.payload.evidence ?? []; node.executor_identity = event.payload.executor_identity ?? node.executor_identity; const a = node.attempts.find(x => x.attempt_id === event.attempt_id); if (a) { a.status = event.payload.status; a.result_digest = event.payload.request_digest; a.result_event = event; } }
    if (event.type === 'attempt_reconciled') { node.status = event.payload.status; const a = node.attempts.find(x => x.attempt_id === event.attempt_id); if (a) { a.status = event.payload.status; a.reconcile_digest = event.payload.request_digest; a.reconcile_event = event; } }
    if (event.type === 'node_invalidated') { node.status = 'invalidated'; node.invalid_reason = event.payload.reason; }
    if (event.type === 'retry_authorized') node.status = 'pending';
  }
  return {nodes: state, receiptIds, usageIds};
}

function usage(events) { const seen = new Map(); for (const e of events) if (e.type === 'usage' && e.payload?.usage_id) { const prior = seen.get(e.payload.usage_id); if (prior && canonical(prior) !== canonical(e.payload)) fail('USAGE_ID_CONFLICT', 'A usage_id maps to conflicting telemetry', {usage_id: e.payload.usage_id}); if (!prior) seen.set(e.payload.usage_id, e.payload); } return [...seen.values()]; }
function descendants(manifest, changed) { const changedSet = new Set(changed), out = new Set(changed); let grew = true; while (grew) { grew = false; for (const n of manifest.nodes) if (!out.has(n.node_id) && n.depends_on.some(d => out.has(d))) { out.add(n.node_id); grew = true; } } return [...out]; }
function expectedInputStates(manifest, events) {
  const states = new Map((manifest.input_hashes || []).map(ref => [ref.path, {exists: ref.exists !== false, sha256: ref.sha256 ?? null}]));
  for (const event of events) if (event.type === 'effect_applied') for (const effect of event.payload?.effects || []) if (states.has(effect.path)) states.set(effect.path, effect.after);
  return states;
}
function changedInputs(manifest, events) {
  const changed = [];
  for (const [logicalPath, expected] of expectedInputStates(manifest, events)) {
    const full = path.isAbsolute(logicalPath) ? path.resolve(logicalPath) : logicalRepoPath(manifest.repo, logicalPath).full;
    const actual = fileState(full);
    if (!sameFileState(actual, expected)) changed.push(logicalPath);
  }
  return changed;
}
function invalidateDrift(dir, manifest, events) {
  const drift = changedInputs(manifest, events);
  if (!drift.length) return [];
  const referencedByNode = new Set(manifest.nodes.flatMap(n => (n.input_refs || []).map(r => r.path)));
  const direct = manifest.nodes.filter(n => (n.input_refs || []).some(r => drift.includes(r.path))).map(n => n.node_id);
  // A changed mandatory packet source (task rules, ancestor instructions) can
  // affect every node even when it is not a node-local input ref.
  const affected = descendants(manifest, drift.some(item => !referencedByNode.has(item)) ? manifest.nodes.map(n => n.node_id) : direct);
  const state = deriveState(manifest, events);
  for (const nodeId of affected) {
    if (state.nodes[nodeId].status === 'passed') appendEvent(dir, {type: 'node_invalidated', node_id: nodeId, payload: {reason: 'source_hash_changed', changed_inputs: drift}});
    if (state.nodes[nodeId].status === 'running' && !events.some(e => e.type === 'input_drift_quarantined' && e.node_id === nodeId)) appendEvent(dir, {type: 'input_drift_quarantined', node_id: nodeId, attempt_id: state.nodes[nodeId].attempts.at(-1)?.attempt_id, payload: {reason: 'source_hash_changed_while_running', changed_inputs: drift}});
  }
  return drift;
}

function lineRange(text, range) {
  if (!range) return {text, range: {start: 1, end: text.split(/\r?\n/).length}};
  const lines = text.split(/\r?\n/), start = range.start ?? 1, end = range.end ?? lines.length;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) fail('INVALID_RANGE', 'Invalid source range', {range});
  return {text: lines.slice(start - 1, end).join('\n'), range: {start, end}};
}
function readContextItem(repo, item, mandatory) {
  const logicalPath = requiredString(item.path, 'context path'); const file = path.isAbsolute(logicalPath) ? logicalPath : safeRelative(repo, logicalPath);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    if (mandatory) fail('MISSING_MANDATORY_CONTEXT', 'Mandatory context file is missing', {path: logicalPath});
    return {missing: true, path: logicalPath};
  }
  const bytes = fs.readFileSync(file); let content;
  try { content = new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { fail('NON_UTF8_CONTEXT', 'Context source must be UTF-8', {path: logicalPath}); }
  const selected = lineRange(content, item.range);
  return {id: item.id || sha256(`${logicalPath}:${JSON.stringify(selected.range)}`).slice(0, 16), path: logicalPath.replaceAll('\\', '/'), version: item.version ?? null, range: selected.range, sha256: sha256(Buffer.from(selected.text, 'utf8')), bytes: Buffer.byteLength(selected.text, 'utf8'), content: selected.text, mandatory};
}
function ancestorInstructions(repo) {
  const out = []; let current = path.resolve(repo), previous = null;
  while (current !== previous) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) { const file = path.join(current, name); if (fs.existsSync(file) && fs.statSync(file).isFile()) out.push({path: file, id: `instruction-${sha256(file).slice(0, 12)}`}); }
    previous = current; current = path.dirname(current);
  }
  return out.reverse();
}
function buildPacket(request, manifest) {
  const config = request.context || {}; const cap = config.max_input_bytes;
  if (!Number.isInteger(cap) || cap < 1) fail('MISSING_CONTEXT_BUDGET', 'context.max_input_bytes is required and must be positive');
  const suppliedMandatory = [...ancestorInstructions(manifest.repo), ...(config.mandatory || [])];
  const suppliedPaths = new Set(suppliedMandatory.map(item => path.isAbsolute(item.path) ? path.resolve(item.path).replaceAll('\\', '/') : logicalRepoPath(manifest.repo, item.path).path));
  const trackedInputs = (manifest.input_hashes || []).filter(ref => !suppliedPaths.has(ref.path)).map(ref => ({path: ref.path, tracked_state: {exists: ref.exists !== false, sha256: ref.sha256 ?? null}}));
  const mandatory = [
    {id: 'user-task', path: 'virtual:user-task', virtual: manifest.task_text},
    {id: 'acceptance', path: 'virtual:acceptance', virtual: manifest.acceptance_criteria.join('\n')},
    ...suppliedMandatory, ...trackedInputs
  ];
  const mandatorySources = [], omitted = [];
  for (const item of mandatory) {
    const source = item.virtual !== undefined ? {id: item.id, path: item.path, range: {start: 1, end: 1}, content: item.virtual, bytes: Buffer.byteLength(item.virtual), sha256: sha256(item.virtual), mandatory: true} : item.tracked_state?.exists === false ? {id: item.id || sha256(item.path).slice(0, 16), path: item.path, range: {start: 1, end: 1}, content: '', bytes: 0, sha256: null, exists: false, mandatory: true} : readContextItem(manifest.repo, item, true);
    mandatorySources.push(source);
  }
  const candidates = [...(config.candidates || [])].sort((a, b) => `${a.path}:${JSON.stringify(a.range || {})}`.localeCompare(`${b.path}:${JSON.stringify(b.range || {})}`));
  const availableCandidates = [];
  for (const item of candidates) {
    const source = readContextItem(manifest.repo, item, false);
    if (source.missing) { omitted.push({id: item.id || item.path, path: item.path, reason: 'missing_optional'}); continue; }
    availableCandidates.push(source);
  }
  const packetId = `packet-${crypto.randomUUID()}`;
  const measure = sources => {
    const draft = {packet_id: packetId, sources}; const byNode = {};
    for (const node of manifest.nodes) {
      const attemptId = `${node.node_id}.attempt-${node.max_attempts}`;
      const expectedEffects = isWriter(node) ? nodeWritePaths(manifest, node).map(item => ({path: item.path, before: fileState(item.full)})) : [];
      byNode[node.node_id] = Buffer.byteLength(nativePrompt(manifest, node, attemptId, draft, expectedEffects), 'utf8');
    }
    return byNode;
  };
  const mandatoryBytes = measure(mandatorySources), mandatoryMax = Math.max(...Object.values(mandatoryBytes));
  if (mandatoryMax > cap) fail('MANDATORY_CONTEXT_OVERFLOW', 'The complete mandatory native handoff message exceeds max_input_bytes; split the task instead of trimming', {max_input_bytes: cap, message_bytes_by_node: mandatoryBytes, measurement: 'Buffer.byteLength(native_action.args.message, utf8)'});
  const candidateBytes = measure([...mandatorySources, ...availableCandidates]);
  const sources = [...mandatorySources];
  for (const source of availableCandidates) {
    const proposed = [...sources, source], measured = measure(proposed);
    if (Math.max(...Object.values(measured)) > cap) { omitted.push({id: source.id, path: source.path, reason: 'native_message_byte_budget'}); continue; }
    sources.push(source);
  }
  const finalBytes = measure(sources), maxFinal = Math.max(...Object.values(finalBytes));
  const used = sources.reduce((sum, source) => sum + source.bytes, 0);
  const overhead = maxFinal - used;
  const packet = {packet_id: packetId, created_at: now(), max_input_bytes: cap, used_source_bytes: used, candidate_source_bytes: [...mandatorySources, ...availableCandidates].reduce((sum, source) => sum + source.bytes, 0), prompt_overhead_bytes: overhead, total_estimated_bytes: maxFinal, message_size: {unit: 'utf8_bytes', method: 'Buffer.byteLength(native_action.args.message, utf8)', status: 'measured', candidate_by_node: candidateBytes, selected_final_by_node: finalBytes, selected_final_max: maxFinal}, estimated_tokens: Math.ceil(maxFinal / 3), token_estimate_method: config.token_estimate_method || 'utf8_bytes_div_3_estimated', token_estimate_status: 'estimated', context_limit_tokens: config.observed_context_limit_tokens ?? null, context_limit_status: config.observed_context_limit_tokens ? 'observed_by_caller' : 'unknown_not_invented', sources, omitted, source_counts: {mandatory: sources.filter(x => x.mandatory).length, optional: sources.filter(x => !x.mandatory).length, omitted: omitted.length}};
  return packet;
}
function writePacket(dir, packet) { const file = path.join(dir, 'packets', `${packet.packet_id}.json`); atomicJson(file, packet); return file; }

export function prepare(request) {
  const dataRoot = requiredString(request.data_root, 'data_root'), runId = cleanId(request.run_id || `run-${crypto.randomUUID()}`, 'run_id'); const dir = runDir(dataRoot, runId);
  if (fs.existsSync(path.join(dir, MANIFEST_FILE))) fail('RUN_EXISTS', 'A run with this id already exists', {run_id: runId});
  const repo = path.resolve(requiredString(request.repo, 'repo')); if (!fs.existsSync(repo)) fail('MISSING_REPO', 'repo does not exist', {repo}); const repo_realpath = repoIdentity(repo);
  const dataReal = path.resolve(dataRoot); if (dataReal === repo_realpath || dataReal.startsWith(`${repo_realpath}${path.sep}`)) fail('DATA_ROOT_IN_REPO', 'data_root must be caller-owned durable storage outside the repository');
  const baseCommit = requiredString(request.base_commit, 'base_commit'); const baseProvenance = verifyBaseCommit(repo, baseCommit, request.allow_unverified_base_commit === true);
  const declaredOutputs = new Set((request.nodes || []).filter(isWriter).flatMap(node => (node.write_paths || []).map(item => logicalRepoPath(repo, item, 'write_paths item').path)));
  const inputRefs = [...(request.input_refs || []), ...((request.nodes || []).flatMap(n => n.input_refs || []))];
  const uniqueRefs = [...new Map(inputRefs.map(ref => { const logical = logicalRepoPath(repo, ref.path, 'input ref path').path; const normalized = normalizedRef(repo, ref, {allowMissing: declaredOutputs.has(logical)}); return [normalized.path, normalized]; })).values()];
  const manifest = {schema_version: SCHEMA_VERSION, tool_version: VERSION, run_id: runId, created_at: now(), task_id: request.task_id || runId, task_text: requiredString(request.task, 'task'), acceptance_criteria: request.acceptance_criteria, initiative_refs: request.initiative_refs || [], repo, repo_realpath, base_commit: baseCommit, base_provenance: baseProvenance, input_hashes: uniqueRefs, baseline_input_hashes: structuredClone(uniqueRefs), client: request.client || 'codex-desktop', adapter_version: 'native-handoff-v1', variant: request.variant || 'B', decision_mode: request.decision_mode || 'off', safe_active: request.safe_active === true, provider_versions: {typesafe: 'jev-1.13.0', ...(request.provider_versions || {})}, budget: {max_concurrent: 2, max_agent_starts: 8, max_decision_calls: 30, max_minutes: 30, max_repair_rounds: 2, ...(request.budget || {})}, nodes: request.nodes, paid_api_enabled: request.paid_api_enabled === true, integrity_hash: null};
  validateManifest(manifest); manifest.integrity_hash = manifestDigest(manifest);
  // Validate and assemble all context before creating a visible run. A failed
  // packet must not reserve a run id with a half-written manifest.
  const packet = buildPacket(request, manifest);
  const release = acquireLock(dir); try {
    if (fs.existsSync(path.join(dir, MANIFEST_FILE))) fail('RUN_EXISTS', 'A run with this id already exists', {run_id: runId});
    const packetRefs = packet.sources.filter(source => !source.path.startsWith('virtual:')).map(source => normalizedRef(repo, {path: source.path}, {allowExternal: true}));
    manifest.input_hashes = [...new Map([...manifest.input_hashes, ...packetRefs].map(ref => [ref.path, ref])).values()]; manifest.baseline_input_hashes = structuredClone(manifest.input_hashes); manifest.integrity_hash = manifestDigest(manifest); atomicJson(path.join(dir, MANIFEST_FILE), manifest);
    const packetFile = writePacket(dir, packet); appendEvent(dir, {type: 'run_prepared', payload: {packet_id: packet.packet_id, packet_file: path.relative(dir, packetFile), manifest_hash: manifest.integrity_hash}}); return {ok: true, run_id: runId, manifest: path.join(dir, MANIFEST_FILE), packet: packetFile, packet_id: packet.packet_id, entrypoint: probe()};
  } finally { release(); }
}

function assertTime(manifest) { if (Date.now() - Date.parse(manifest.created_at) > manifest.budget.max_minutes * 60_000) fail('TIME_BUDGET_EXCEEDED', 'Run time budget prevents new starts'); }
function nodeById(manifest, id) { const node = manifest.nodes.find(n => n.node_id === id); if (!node) fail('NODE_NOT_FOUND', 'Node not found', {node_id: id}); return node; }
function isWriter(node) { return node.write_scope && node.write_scope !== 'read-only' && node.write_scope !== 'none'; }
function readyNodes(manifest, state) {
  return manifest.nodes.filter(node => state.nodes[node.node_id].status === 'pending' && node.depends_on.every(dep => state.nodes[dep].status === 'passed'));
}
function currentRunning(state) { return Object.entries(state.nodes).filter(([, n]) => n.status === 'running' || n.status === 'unknown'); }
function attemptCount(events) { return events.filter(e => e.type === 'attempt_intent').length; }
function repairCount(events) { return events.filter(e => e.type === 'attempt_intent' && e.payload?.attempt_number > 1).length; }

export function next(request) { return withLock(request.data_root, request.run_id, () => nextLocked(request)); }
function nextLocked(request) {
  const {dir, manifest, events} = loadRun(request.data_root, request.run_id, {allowCatchup: request.safe_checkpoint_catchup === true});
  const drift = invalidateDrift(dir, manifest, events); const loaded = loadRun(request.data_root, request.run_id); const state = deriveState(loaded.manifest, loaded.events); const running = currentRunning(state);
  const provenance_drift = provenanceDrift(loaded.manifest); const time_exhausted = Date.now() - Date.parse(loaded.manifest.created_at) > loaded.manifest.budget.max_minutes * 60_000;
  const cancellation_required = running.flatMap(([node_id, current]) => { const n = nodeById(loaded.manifest, node_id), attempt = current.attempts.at(-1); return Date.now() - Date.parse(attempt?.started_at || 0) > n.timeout_seconds * 1000 ? [{node_id, attempt_id: attempt?.attempt_id, action: 'cancellation_required', reason: 'adapter cannot autonomously kill native agent'}] : []; });
  const nodeRefPaths = new Set(loaded.manifest.nodes.flatMap(n => (n.input_refs || []).map(ref => ref.path))); const globalContextDrift = drift.some(item => !nodeRefPaths.has(item));
  const quarantined_running = running.filter(([node_id]) => globalContextDrift || loaded.manifest.nodes.find(n => n.node_id === node_id).input_refs?.some(ref => drift.includes(ref.path))).map(([node_id, n]) => ({node_id, attempt_id: n.attempts.at(-1)?.attempt_id, action: 'reconcile_input_drift', writer_reservation_retained: true}));
  if (cancellation_required.length || quarantined_running.length || provenance_drift || time_exhausted) return {ok: true, run_id: request.run_id, ready: [], running: running.map(([node_id, n]) => ({node_id, attempt_id: n.attempts.at(-1)?.attempt_id, status: 'unknown_or_running'})), cancellation_required, quarantined_running, drift, provenance_drift, time_exhausted};
  let ready = readyNodes(loaded.manifest, state); const startsLeft = loaded.manifest.budget.max_agent_starts - attemptCount(loaded.events); if (startsLeft <= 0) ready = [];
  const availableSlots = Math.max(0, loaded.manifest.budget.max_concurrent - running.length);
  const writer = writerReservation(request.data_root, loaded.manifest.repo); const globallyReserved = fs.existsSync(writer) ? readJson(writer) : null;
  ready = ready.filter(n => !isWriter(n) || !globallyReserved || (globallyReserved.run_id === request.run_id && globallyReserved.node_id === n.node_id));
  const chosen = [], capacity = Math.min(availableSlots, startsLeft); let writerChosen = !!globallyReserved;
  for (const candidate of ready) { if (chosen.length >= capacity) break; if (isWriter(candidate) && writerChosen) continue; chosen.push(candidate); if (isWriter(candidate)) writerChosen = true; }
  return {ok: true, run_id: request.run_id, ready: chosen.map(n => ({node_id: n.node_id, writer: isWriter(n), deps: n.depends_on})), running: running.map(([node_id, n]) => ({node_id, attempt_id: n.attempts.at(-1)?.attempt_id, status: 'running'})), drift, provenance_drift: null, time_exhausted: false, limits: {agent_starts_left: Math.max(0, startsLeft), repair_rounds_left: Math.max(0, loaded.manifest.budget.max_repair_rounds - repairCount(loaded.events))}};
}

function reserveWriter(dataRoot, manifest, node, attemptId) {
  if (!isWriter(node)) return null;
  const file = writerReservation(dataRoot, manifest.repo); fs.mkdirSync(path.dirname(file), {recursive: true});
  if (fs.existsSync(file)) { const current = readJson(file); if (current.run_id !== manifest.run_id || current.node_id !== node.node_id || current.attempt_id !== attemptId) fail('WRITER_RESERVED', 'A writer is already reserved for this real repository tree', {reservation: current}); return file; }
  const reservation = {repo_realpath: repoIdentity(manifest.repo), run_id: manifest.run_id, node_id: node.node_id, attempt_id: attemptId, reserved_at: now()};
  try { const fd = fs.openSync(file, 'wx'); try { fs.writeFileSync(fd, `${JSON.stringify(reservation)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch (error) { if (error.code === 'EEXIST') fail('WRITER_RESERVED', 'A writer is already reserved for this real repository tree', {reservation: readJson(file)}); throw error; } return file;
}
function releaseWriter(dataRoot, manifest, node, attemptId) {
  if (!isWriter(node)) return; const file = writerReservation(dataRoot, manifest.repo); if (!fs.existsSync(file)) return;
  const current = readJson(file); if (current.run_id === manifest.run_id && current.node_id === node.node_id && current.attempt_id === attemptId) {
    const released = `${file}.released-${Date.now()}-${crypto.randomUUID()}`; fs.renameSync(file, released); if (fs.existsSync(file)) fail('WRITER_RELEASE_FAILED', 'Writer reservation active name remained after atomic release rename', {file, released});
  }
}
function nativePrompt(manifest, node, attemptId, packet, expectedEffects = []) {
  const sourceText = packet.sources.map(s => `--- SOURCE ${s.id} ${s.path}:${s.range.start}-${s.range.end} sha256=${s.sha256}\n${s.content}\n--- END SOURCE`).join('\n');
  return `You are the native executor for Graf run ${manifest.run_id}, node ${node.node_id}, attempt ${attemptId}.\n\nGoal:\n${node.goal}\n\nAcceptance:\n${node.acceptance.map(x => `- ${x}`).join('\n')}\n\nScope:\nwrite_scope=${node.write_scope}; input_refs=${JSON.stringify(node.input_refs || [])}; write_paths=${JSON.stringify((node.write_paths || []).map(item => logicalRepoPath(manifest.repo, item).path))}\n\nPredeclared effect baseline:\n${JSON.stringify(expectedEffects)}\n\nReturn exactly a JSON object with {status:"passed"|"failed"|"blocked"|"cancelled", summary:string, evidence:[{path:string,sha256:string}], effects:[{path:string,before:{exists:boolean,sha256:string|null},after:{exists:boolean,sha256:string|null}}], executor_identity:string}. Every changed path must be predeclared and every effect hash must match the filesystem. Do not claim actions you did not perform.\n\nBounded source packet ${packet.packet_id}:\n${sourceText}`;
}
function latestPacket(dir, events = readEvents(dir)) {
  const packetId = [...events].reverse().find(event => event.payload?.packet_id && ['run_prepared', 'packet_refreshed'].includes(event.type))?.payload.packet_id;
  if (!packetId) fail('MISSING_PACKET', 'Run has no source packet');
  return readJson(path.join(dir, 'packets', `${packetId}.json`));
}

export function dispatch(request) {
  return withLock(request.data_root, request.run_id, dir => {
    const {manifest, events} = loadRun(request.data_root, request.run_id, {allowCatchup: request.safe_checkpoint_catchup === true}); const drift = invalidateDrift(dir, manifest, events);
    const loaded = loadRun(request.data_root, request.run_id), state = deriveState(loaded.manifest, loaded.events), node = nodeById(loaded.manifest, request.node_id);
    const provenance = provenanceDrift(loaded.manifest); if (provenance) fail('GIT_PROVENANCE_DRIFT', 'Git HEAD or base ref changed since prepare', provenance);
    if (drift.length) fail('INPUT_DRIFT', 'Tracked inputs changed before dispatch', {changed_inputs: drift});
    assertTime(loaded.manifest); if (state.nodes[node.node_id].status !== 'pending') fail('NOT_DISPATCHABLE', 'Node is not pending', {node_id: node.node_id, status: state.nodes[node.node_id].status});
    if (!node.depends_on.every(dep => state.nodes[dep].status === 'passed')) fail('DEPENDENCY_NOT_PASSED', 'Required dependencies have not passed', {node_id: node.node_id});
    const running = currentRunning(state); if (running.length >= loaded.manifest.budget.max_concurrent) fail('CONCURRENCY_LIMIT', 'Concurrent-agent limit reached');
    const starts = attemptCount(loaded.events); if (starts >= loaded.manifest.budget.max_agent_starts) fail('AGENT_START_LIMIT', 'Agent-start budget reached');
    const previous = state.nodes[node.node_id].attempts.length; if (previous >= node.max_attempts) fail('NODE_ATTEMPT_LIMIT', 'Node attempt limit reached');
    if (previous > 0 && repairCount(loaded.events) >= loaded.manifest.budget.max_repair_rounds) fail('REPAIR_LIMIT', 'Repair-round budget reached');
    const attemptId = `${node.node_id}.attempt-${previous + 1}`, operationId = `operation-${crypto.randomUUID()}`;
    const expectedEffects = isWriter(node) ? nodeWritePaths(loaded.manifest, node).map(item => ({path: item.path, before: fileState(item.full)})) : [];
    const packet = latestPacket(dir, loaded.events), message = nativePrompt(loaded.manifest, node, attemptId, packet, expectedEffects), messageBytes = Buffer.byteLength(message, 'utf8');
    if (messageBytes > packet.max_input_bytes) fail('CONTEXT_BUDGET_EXCEEDED', 'The exact native action message exceeds max_input_bytes; no intent or action was created', {message_bytes: messageBytes, max_input_bytes: packet.max_input_bytes, measurement: 'Buffer.byteLength(native_action.args.message, utf8)'});
    reserveWriter(request.data_root, loaded.manifest, node, attemptId);
    try { appendEvent(dir, {type: 'attempt_intent', node_id: node.node_id, attempt_id: attemptId, payload: {attempt_number: previous + 1, operation_id: operationId, expected_effects: expectedEffects, packet_id: packet.packet_id, message_bytes: messageBytes, executor_identity: request.executor_identity || node.executor, native_action: 'collaboration.spawn_agent', reservation: isWriter(node)}}); }
    catch (error) { releaseWriter(request.data_root, loaded.manifest, node, attemptId); throw error; }
    const taskName = `graf_${sha256(`${loaded.manifest.run_id}:${node.node_id}`).slice(0, 10)}_${node.node_id.replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 45)}_${previous + 1}`;
    return {ok: true, run_id: loaded.manifest.run_id, node_id: node.node_id, attempt_id: attemptId, operation_id: operationId, message_bytes: messageBytes, native_action: {tool: 'collaboration.spawn_agent', args: {task_name: taskName, message, model: node.model, reasoning_effort: node.effort, fork_turns: 'none'}}, decision_mode: loaded.manifest.decision_mode};
  });
}

export function ack(request) {
  return withLock(request.data_root, request.run_id, dir => {
    const {manifest, events} = loadRun(request.data_root, request.run_id, {allowCatchup: request.safe_checkpoint_catchup === true}); const state = deriveState(manifest, events), node = nodeById(manifest, request.node_id);
    const attempt = state.nodes[node.node_id].attempts.find(x => x.attempt_id === request.attempt_id); if (!attempt) fail('UNKNOWN_ATTEMPT', 'Cannot acknowledge an unknown attempt');
    const receiptId = requiredString(request.receipt_id, 'receipt_id'), toolAgentId = requiredString(request.tool_agent_id, 'tool_agent_id');
    const receipt = state.receiptIds.get(receiptId);
    if (receipt) { if (receipt.node_id === node.node_id && receipt.attempt_id === request.attempt_id && receipt.tool_agent_id === toolAgentId) return {ok: true, idempotent: true, receipt_id: receiptId}; fail('RECEIPT_ID_CONFLICT', 'receipt_id is already bound to a different attempt/tool tuple', {receipt_id: receiptId, existing: receipt}); }
    if (attempt.status === 'running') fail('ATTEMPT_ALREADY_ACKED', 'Attempt already has a different receipt tuple', {receipt_id: attempt.receipt_id, tool_agent_id: attempt.tool_agent_id});
    if (attempt.status !== 'unknown') fail('INVALID_ACK', 'Only a durable unknown intent may be acknowledged');
    appendEvent(dir, {type: 'attempt_receipt', node_id: node.node_id, attempt_id: request.attempt_id, payload: {receipt_id: receiptId, tool_agent_id: toolAgentId}});
    return {ok: true, receipt_id: receiptId};
  });
}

export function reconcile(request) {
  return withLock(request.data_root, request.run_id, dir => {
    const {manifest, events} = loadRun(request.data_root, request.run_id, {allowCatchup: request.safe_checkpoint_catchup === true}); const state = deriveState(manifest, events), node = nodeById(manifest, request.node_id);
    const attempt = state.nodes[node.node_id].attempts.find(item => item.attempt_id === request.attempt_id); if (!attempt) fail('UNKNOWN_ATTEMPT', 'Cannot reconcile an unknown attempt');
    const status = requiredString(request.status, 'status'); if (!['failed', 'blocked', 'cancelled', 'timeout'].includes(status)) fail('INVALID_RECONCILIATION', 'Reconciliation may terminate an attempt only as failed, blocked, cancelled, or timeout');
    if (request.effect_checked !== true || !Array.isArray(request.reconciliation_evidence) || !request.reconciliation_evidence.length) fail('RECONCILIATION_EVIDENCE_REQUIRED', 'Reconciliation requires effect_checked:true and evidence');
    if (attempt.status === 'running' && request.executor_identity !== attempt.tool_agent_id) fail('EXECUTOR_IDENTITY_MISMATCH', 'Running-agent reconciliation must name the receipt tool_agent_id');
    const normalizedUsage = withUnavailableAttemptUsage(normalizeUsageRecords(request.usage, state.usageIds), state.usageIds, manifest, node, attempt);
    const requestDigest = sha256(canonical({status, effect_checked: true, reconciliation_evidence: request.reconciliation_evidence, effects: request.effects || [], executor_identity: request.executor_identity ?? null, usage: normalizedUsage.all}));
    if (attempt.reconcile_event) { if (attempt.reconcile_digest === requestDigest) { ensureTerminalFinalized(dir, request.data_root, manifest, node, request.attempt_id, status, events); return {ok: true, idempotent: true, node_id: node.node_id, status}; } fail('RECONCILIATION_CONFLICT', 'Attempt already has a different reconciliation'); }
    if (!['unknown', 'running'].includes(attempt.status)) fail('INVALID_RECONCILIATION', 'Only an unknown or running attempt can be reconciled', {status: attempt.status});
    const effects = verifyEffects(manifest, events, node, attempt, request.effects);
    const priorEffect = events.find(event => event.type === 'effect_applied' && event.node_id === node.node_id && event.attempt_id === request.attempt_id);
    if (priorEffect && canonical(priorEffect.payload.effects) !== canonical(effects)) fail('EFFECT_CONFLICT', 'Attempt already recorded a different effect set');
    if (!priorEffect && effects.length) { const effectEvent = appendEvent(dir, {type: 'effect_applied', node_id: node.node_id, attempt_id: request.attempt_id, payload: {operation_id: attempt.operation_id, effects, effect_checked: true, source: 'reconcile'}}); refreshPacket(dir, manifest, readEvents(dir), effects, effectEvent); }
    else if (priorEffect) ensureEffectPacket(dir, manifest, readEvents(dir), node.node_id, request.attempt_id);
    for (const item of normalizedUsage.fresh) appendEvent(dir, {type: 'usage', node_id: node.node_id, attempt_id: request.attempt_id, payload: item});
    appendEvent(dir, {type: 'attempt_reconciled', node_id: node.node_id, attempt_id: request.attempt_id, payload: {status, effect_checked: true, reconciliation_evidence: request.reconciliation_evidence, effects, executor_identity: request.executor_identity ?? null, request_digest: requestDigest}});
    ensureTerminalFinalized(dir, request.data_root, manifest, node, request.attempt_id, status); return {ok: true, node_id: node.node_id, status, effects};
  });
}

export function retry(request) {
  return withLock(request.data_root, request.run_id, dir => {
    const {manifest, events} = loadRun(request.data_root, request.run_id, {allowCatchup: request.safe_checkpoint_catchup === true}); const state = deriveState(manifest, events), node = nodeById(manifest, request.node_id);
    const prior = state.nodes[node.node_id].attempts.find(attempt => attempt.attempt_id === request.previous_attempt_id);
    if (!prior || !['failed', 'blocked', 'cancelled', 'timeout'].includes(prior.status)) fail('RETRY_NOT_ALLOWED', 'Only a terminal failed/blocked/cancelled/timeout attempt can be retried');
    if (state.nodes[node.node_id].status !== prior.status) fail('RETRY_NOT_ALLOWED', 'Node state no longer matches the requested prior attempt');
    if (state.nodes[node.node_id].attempts.length >= node.max_attempts) fail('NODE_ATTEMPT_LIMIT', 'Node attempt limit reached');
    if (repairCount(events) >= manifest.budget.max_repair_rounds) fail('REPAIR_LIMIT', 'Repair-round budget reached');
    if (request.effect_checked !== true || !Array.isArray(request.reconciliation_evidence) || !request.reconciliation_evidence.length) fail('RECONCILIATION_EVIDENCE_REQUIRED', 'Retry requires explicit effect_checked:true and reconciliation evidence');
    appendEvent(dir, {type: 'retry_authorized', node_id: node.node_id, attempt_id: request.previous_attempt_id, payload: {previous_attempt_id: request.previous_attempt_id, effect_checked: true, reconciliation_evidence: request.reconciliation_evidence}});
    return {ok: true, node_id: node.node_id, status: 'pending', next_action: 'dispatch'};
  });
}

function snapshotEvidence(dir, attemptId, evidence) {
  if (!Array.isArray(evidence) || !evidence.length) fail('MISSING_EVIDENCE', 'A passed result needs evidence paths and hashes');
  const target = path.join(dir, 'evidence', cleanId(attemptId, 'attempt_id')); fs.mkdirSync(target, {recursive: true});
  return evidence.map((item, index) => {
    const source = path.resolve(requiredString(item.path, 'evidence path')); if (!fs.existsSync(source) || !fs.statSync(source).isFile()) fail('MISSING_EVIDENCE', 'Evidence file is missing', {path: item.path});
    const hash = sourceHash(source); if (hash !== requiredString(item.sha256, 'evidence sha256')) fail('EVIDENCE_HASH_MISMATCH', 'Evidence changed or hash is wrong', {path: item.path});
    const name = `${index + 1}-${path.basename(source).replace(/[^A-Za-z0-9_.-]/g, '_')}`; const copy = path.join(target, name); fsyncFile(copy, fs.readFileSync(source));
    return {path: item.path, sha256: hash, snapshot: path.relative(dir, copy).replaceAll('\\', '/')};
  });
}
function normalizeEffectState(value, name) {
  if (!value || typeof value !== 'object' || typeof value.exists !== 'boolean') fail('INVALID_EFFECT', `${name} must contain exists:boolean and sha256`);
  if (value.exists && (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256))) fail('INVALID_EFFECT', `${name}.sha256 must be a lowercase SHA-256 when the file exists`);
  if (!value.exists && value.sha256 !== null) fail('INVALID_EFFECT', `${name}.sha256 must be null when the file does not exist`);
  return {exists: value.exists, sha256: value.sha256};
}
function verifyEffects(manifest, events, node, attempt, rawEffects) {
  const effects = rawEffects ?? [];
  if (!Array.isArray(effects)) fail('INVALID_EFFECT', 'effects must be an array');
  if (!isWriter(node)) {
    if (effects.length) fail('UNDECLARED_EFFECT', 'A read-only node cannot report repository effects');
    const drift = changedInputs(manifest, events); if (drift.length) fail('INPUT_DRIFT_QUARANTINED', 'Tracked inputs changed during a read-only attempt', {changed_inputs: drift});
    return [];
  }
  const allowed = new Map(nodeWritePaths(manifest, node).map(item => [item.path, item]));
  const baselines = new Map((attempt.expected_effects || []).map(item => [item.path, item.before]));
  const normalized = effects.map(item => {
    const logical = logicalRepoPath(manifest.repo, item.path, 'effect path'); const allowedItem = allowed.get(logical.path);
    if (!allowedItem) fail('UNDECLARED_EFFECT', 'Effect path was not predeclared in node.write_paths', {node_id: node.node_id, path: item.path});
    const before = normalizeEffectState(item.before, 'effect.before'), after = normalizeEffectState(item.after, 'effect.after'), expected = baselines.get(logical.path), actual = fileState(allowedItem.full);
    if (!sameFileState(before, expected)) fail('EFFECT_BEFORE_MISMATCH', 'Effect before hash does not match the durable attempt baseline', {path: logical.path, expected, reported: before});
    if (!sameFileState(after, actual)) fail('EFFECT_AFTER_MISMATCH', 'Effect after hash does not match the current file', {path: logical.path, actual, reported: after});
    if (sameFileState(before, after)) fail('INVALID_EFFECT', 'An effect must describe an actual state change', {path: logical.path});
    return {path: logical.path, before, after};
  });
  if (new Set(normalized.map(item => item.path)).size !== normalized.length) fail('DUPLICATE_EFFECT', 'effects contains a duplicate path');
  const actualChanged = [...allowed].filter(([logicalPath, item]) => !sameFileState(fileState(item.full), baselines.get(logicalPath))).map(([logicalPath]) => logicalPath).sort();
  const reportedChanged = normalized.map(item => item.path).sort();
  if (canonical(actualChanged) !== canonical(reportedChanged)) fail('EFFECT_SET_MISMATCH', 'effects must exactly cover every changed predeclared path', {actual_changed: actualChanged, reported_changed: reportedChanged});
  const trackedDrift = changedInputs(manifest, events), unexpected = trackedDrift.filter(item => !allowed.has(item));
  if (unexpected.length) fail('INPUT_DRIFT_QUARANTINED', 'Unexpected tracked input drift remains outside the predeclared effect allowlist', {changed_inputs: unexpected});
  return normalized;
}
function refreshPacket(dir, manifest, events, effects, effectEvent = null) {
  if (!effects.length) return null;
  const previous = latestPacket(dir, events), affected = new Set(effects.map(item => item.path));
  const sources = previous.sources.map(source => {
    if (source.path.startsWith('virtual:') || !affected.has(source.path)) return source;
    const full = logicalRepoPath(manifest.repo, source.path).full;
    if (!fs.existsSync(full)) return {...source, exists: false, sha256: null, bytes: 0, content: ''};
    const refreshed = readContextItem(manifest.repo, {path: source.path, range: source.range, id: source.id, version: source.version}, source.mandatory);
    return {...refreshed, id: source.id, mandatory: source.mandatory};
  });
  const packet = {...previous, packet_id: `packet-${crypto.randomUUID()}`, created_at: now(), refreshed_from: previous.packet_id, sources};
  const byNode = {};
  for (const node of manifest.nodes) {
    const attemptId = `${node.node_id}.attempt-${node.max_attempts}`;
    const expected = isWriter(node) ? nodeWritePaths(manifest, node).map(item => ({path: item.path, before: fileState(item.full)})) : [];
    byNode[node.node_id] = Buffer.byteLength(nativePrompt(manifest, node, attemptId, packet, expected), 'utf8');
  }
  packet.used_source_bytes = sources.reduce((sum, source) => sum + source.bytes, 0); packet.prompt_overhead_bytes = Math.max(...Object.values(byNode)) - packet.used_source_bytes; packet.total_estimated_bytes = Math.max(...Object.values(byNode)); packet.message_size = {...packet.message_size, selected_final_by_node: byNode, selected_final_max: packet.total_estimated_bytes}; packet.estimated_tokens = Math.ceil(packet.total_estimated_bytes / 3); packet.overflow_by_node = Object.fromEntries(Object.entries(byNode).filter(([, bytes]) => bytes > packet.max_input_bytes));
  writePacket(dir, packet); appendEvent(dir, {type: 'packet_refreshed', node_id: effectEvent?.node_id ?? null, attempt_id: effectEvent?.attempt_id ?? null, payload: {packet_id: packet.packet_id, refreshed_from: previous.packet_id, effect_event_hash: effectEvent?.hash ?? null, effects: effects.map(item => item.path), overflow_by_node: packet.overflow_by_node}}); return packet;
}
function ensureEffectPacket(dir, manifest, events, nodeId, attemptId) {
  const effectEvent = events.find(event => event.type === 'effect_applied' && event.node_id === nodeId && event.attempt_id === attemptId); if (!effectEvent) return null;
  const refreshed = events.some(event => event.type === 'packet_refreshed' && (event.payload?.effect_event_hash === effectEvent.hash || (event.seq > effectEvent.seq && event.node_id === nodeId && event.attempt_id === attemptId)));
  return refreshed ? null : refreshPacket(dir, manifest, events, effectEvent.payload.effects || [], effectEvent);
}
function ensureTerminalFinalized(dir, dataRoot, manifest, node, attemptId, status, events = readEvents(dir)) {
  ensureEffectPacket(dir, manifest, events, node.node_id, attemptId); const current = readEvents(dir);
  if (!current.some(event => event.type === 'gate' && event.node_id === node.node_id && event.attempt_id === attemptId)) appendEvent(dir, {type: 'gate', node_id: node.node_id, attempt_id: attemptId, payload: {required: node.required === true, status, allowed: status === 'passed' || node.required !== true}});
  releaseWriter(dataRoot, manifest, node, attemptId);
}
function normalizeUsageRecords(items, priorUsage) {
  if (items === undefined) return {all: [], fresh: []};
  if (!Array.isArray(items)) fail('INVALID_USAGE', 'usage must be an array');
  const requestSeen = new Map(), out = [];
  for (const item of items) {
    const usage_id = requiredString(item.usage_id, 'usage_id'), measurement = item.measurement ?? item.status ?? 'unavailable';
    if (!['measured', 'estimated', 'unavailable'].includes(measurement)) fail('INVALID_USAGE', 'usage measurement/status must be measured, estimated, or unavailable', {usage_id});
    const values = {}; for (const key of ['input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_tokens']) { const value = item[key] ?? null; if (value !== null && (!Number.isFinite(value) || !Number.isInteger(value) || value < 0)) fail('INVALID_USAGE', `${key} must be a non-negative integer or null`, {usage_id}); values[key] = value; }
    if (measurement === 'measured' && (values.input_tokens === null || values.output_tokens === null)) fail('INVALID_USAGE', 'Measured usage requires non-null input_tokens and output_tokens', {usage_id});
    const normalized = {usage_id, provider: item.provider ?? 'native-agent', model: item.model ?? null, ...values, unit: item.unit ?? 'tokens', source: item.source ?? 'native_receipt', measurement, status: item.status ?? measurement};
    if (normalized.unit !== 'tokens') fail('INVALID_USAGE', 'Graf v1 usage unit must be tokens', {usage_id});
    const requestPrior = requestSeen.get(usage_id); if (requestPrior && canonical(requestPrior) !== canonical(normalized)) fail('USAGE_ID_CONFLICT', 'Duplicate usage_id has conflicting values in one request', {usage_id});
    if (!requestPrior) requestSeen.set(usage_id, normalized);
  }
  for (const item of requestSeen.values()) { const prior = priorUsage.get(item.usage_id); if (prior && canonical(prior) !== canonical(item)) fail('USAGE_ID_CONFLICT', 'usage_id conflicts with durable telemetry', {usage_id: item.usage_id}); if (!prior) out.push(item); }
  return {all: [...requestSeen.values()], fresh: out};
}
function withUnavailableAttemptUsage(normalized, priorUsage, manifest, node, attempt) {
  if (normalized.all.length) return normalized;
  const item = {usage_id: `native-${manifest.run_id}-${attempt.attempt_id}`, provider: 'native-agent', model: node.model ?? null, input_tokens: null, output_tokens: null, cached_input_tokens: null, reasoning_tokens: null, unit: 'tokens', source: 'native_tool_no_telemetry', measurement: 'unavailable', status: 'unavailable'};
  const prior = priorUsage.get(item.usage_id); if (prior && canonical(prior) !== canonical(item)) fail('USAGE_ID_CONFLICT', 'Automatic attempt usage conflicts with durable telemetry', {usage_id: item.usage_id}); return {all: [item], fresh: prior ? [] : [item]};
}
export function record(request) {
  return withLock(request.data_root, request.run_id, dir => {
    const {manifest, events} = loadRun(request.data_root, request.run_id, {allowCatchup: request.safe_checkpoint_catchup === true}); invalidateDrift(dir, manifest, events);
    const loaded = loadRun(request.data_root, request.run_id), state = deriveState(loaded.manifest, loaded.events), node = nodeById(loaded.manifest, request.node_id); const status = requiredString(request.status, 'status');
    const provenance = provenanceDrift(loaded.manifest); if (provenance) fail('GIT_PROVENANCE_DRIFT', 'Git HEAD or base ref changed while the attempt was running', provenance);
    if (!['passed', 'failed', 'blocked', 'cancelled', 'timeout'].includes(status)) fail('INVALID_RESULT', 'Result status must be passed, failed, blocked, cancelled, or timeout');
    const attempt = state.nodes[node.node_id].attempts.find(x => x.attempt_id === request.attempt_id); if (!attempt) fail('INVALID_RESULT', 'Attempt does not exist');
    const identity = requiredString(request.executor_identity, 'executor_identity'); if (identity !== attempt.tool_agent_id) fail('EXECUTOR_IDENTITY_MISMATCH', 'record executor_identity must equal the receipt native tool_agent_id');
    const normalizedUsage = withUnavailableAttemptUsage(normalizeUsageRecords(request.usage, state.usageIds), state.usageIds, loaded.manifest, node, attempt);
    const requestDigest = sha256(canonical({status, summary: request.summary || '', executor_identity: identity, evidence: request.evidence || [], effects: request.effects || [], usage: normalizedUsage.all}));
    if (attempt.result_event) { if (attempt.result_digest === requestDigest) { ensureTerminalFinalized(dir, request.data_root, loaded.manifest, node, request.attempt_id, attempt.result_event.payload.status, loaded.events); return {ok: true, idempotent: true, node_id: node.node_id, status: attempt.result_event.payload.status, evidence: attempt.result_event.payload.evidence ?? []}; } fail('RESULT_CONFLICT', 'Attempt already has a different completed result', {attempt_id: request.attempt_id}); }
    if (attempt.status !== 'running') fail('INVALID_RESULT', 'Only a receipt-backed running attempt may record a result');
    if (status === 'passed' && node.kind === 'review' && node.reviewer_for) { const implementer = state.nodes[node.reviewer_for]?.executor_identity; if (!implementer || implementer === identity) fail('REVIEWER_NOT_INDEPENDENT', 'Reviewer identity must differ from implementer'); }
    const effects = verifyEffects(loaded.manifest, loaded.events, node, attempt, request.effects);
    const evidence = status === 'passed' ? snapshotEvidence(dir, request.attempt_id, request.evidence) : [];
    const priorEffect = loaded.events.find(event => event.type === 'effect_applied' && event.node_id === node.node_id && event.attempt_id === request.attempt_id);
    if (priorEffect && canonical(priorEffect.payload.effects) !== canonical(effects)) fail('EFFECT_CONFLICT', 'Attempt already recorded a different effect set');
    if (!priorEffect && effects.length) { const effectEvent = appendEvent(dir, {type: 'effect_applied', node_id: node.node_id, attempt_id: request.attempt_id, payload: {operation_id: attempt.operation_id, effects, effect_checked: true, source: 'record'}}); refreshPacket(dir, loaded.manifest, readEvents(dir), effects, effectEvent); }
    else if (priorEffect) ensureEffectPacket(dir, loaded.manifest, readEvents(dir), node.node_id, request.attempt_id);
    for (const item of normalizedUsage.fresh) appendEvent(dir, {type: 'usage', node_id: node.node_id, attempt_id: request.attempt_id, payload: item});
    appendEvent(dir, {type: 'node_result', node_id: node.node_id, attempt_id: request.attempt_id, payload: {status, summary: request.summary || '', evidence, effects, executor_identity: identity, request_digest: requestDigest}});
    ensureTerminalFinalized(dir, request.data_root, loaded.manifest, node, request.attempt_id, status); return {ok: true, node_id: node.node_id, status, evidence};
  });
}

function validateTypeSafeAnswer(body, questions, model) {
  if (!body || body.model !== model || !body.answers || typeof body.answers !== 'object') fail('MALFORMED_PROVIDER_RESPONSE', 'TypeSafe response model or answers are invalid');
  for (const [id, question] of Object.entries(questions)) {
    const answer = body.answers[id]; if (!answer || answer.type !== question.type) fail('MALFORMED_PROVIDER_RESPONSE', 'TypeSafe response type is invalid', {question: id});
    if (question.type === 'choice') {
      const labels = Object.keys(question.criteria || {}); if (!labels.length || !labels.includes(answer.choice)) fail('MALFORMED_PROVIDER_RESPONSE', 'TypeSafe response has an invalid answer label', {question: id});
      const probabilities = answer.probabilities || {}; if (Object.keys(probabilities).length !== labels.length || labels.some(label => !Object.hasOwn(probabilities, label))) fail('MALFORMED_PROVIDER_RESPONSE', 'TypeSafe probability labels are invalid', {question: id});
      const values = Object.values(probabilities); if (values.some(x => !Number.isFinite(x) || x < 0) || Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 1e-6) fail('MALFORMED_PROVIDER_RESPONSE', 'TypeSafe probabilities are invalid', {question: id});
    } else fail('UNSUPPORTED_QUESTION', 'Graf v1 uses TypeSafe choice questions only', {question: id});
    if (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) fail('MALFORMED_PROVIDER_RESPONSE', 'TypeSafe confidence is invalid', {question: id});
  }
  if (body.usage !== undefined) {
    for (const key of ['input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_tokens']) { const value = body.usage[key]; if (value !== undefined && (!Number.isInteger(value) || value < 0)) fail('MALFORMED_PROVIDER_RESPONSE', 'TypeSafe usage is invalid', {field: key}); }
    if (!Number.isInteger(body.usage.input_tokens) || !Number.isInteger(body.usage.output_tokens)) fail('MALFORMED_PROVIDER_RESPONSE', 'TypeSafe measured usage requires input_tokens and output_tokens');
  }
  return body;
}
function rulesDecision(kind, candidates = []) {
  if (kind === 'context_rank') return {chosen: candidates.map(x => x.id || x.path).sort(), reason: 'rules_baseline_path_order'};
  if (kind === 'delegation') return {chosen: 'standard', reason: 'rules_baseline_client_policy'};
  return {chosen: 'unknown', reason: 'rules_baseline_unknown_kind'};
}
async function typesafeDecision({model = 'jev-1.13.0', state, questions, apiKey, fetchImpl = fetch, timeout_ms = 10_000}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout_ms);
  try {
    const response = await fetchImpl('https://api.typesafe.ai/v1/systemone', {method: 'POST', redirect: 'error', signal: controller.signal, headers: {'content-type': 'application/json', authorization: `Bearer ${apiKey}`}, body: JSON.stringify({model, state, questions})});
    if (!response.ok) fail('PROVIDER_ERROR', 'TypeSafe returned a non-success status', {status: response.status});
    return validateTypeSafeAnswer(await response.json(), questions, model);
  } catch (error) { if (error instanceof GrafError) throw error; if (error.name === 'AbortError') fail('PROVIDER_TIMEOUT', 'TypeSafe decision timed out'); fail('PROVIDER_ERROR', 'TypeSafe request failed', {name: error.name}); } finally { clearTimeout(timer); }
}
export async function decide(request, deps = {}) {
  const {dir, manifest} = loadRun(request.data_root, request.run_id, {allowCatchup: request.safe_checkpoint_catchup === true}); const kind = requiredString(request.kind, 'kind');
  const baseline = rulesDecision(kind, request.candidates || []); const policy = request.policy_version || 'graf-v1'; const model = request.model || manifest.provider_versions.typesafe;
  const state = request.state || {}; const questions = request.questions || {}; const semantic = {provider: 'typesafe', model, state, questions, kind, policy, candidates: request.candidates || []}; const key = sha256(canonical(semantic)); const cacheFile = path.join(dir, 'decisions', `${key}.json`);
  let outcome = {provider: 'rules', model: null, result: baseline, fallback_reason: null, measurement: 'unavailable', paid_attempt: false};
  const active = manifest.decision_mode === 'active', shadow = manifest.decision_mode === 'shadow';
  const apiKey = request.api_key || process.env.TYPESAFE_API_KEY;
  const permitted = manifest.paid_api_enabled === true && Number.isFinite(request.approved_api_budget) && request.approved_api_budget > 0 && !!apiKey;
  const decisionId = `decision-${crypto.randomUUID()}`; let shouldCall = false;
  if (manifest.decision_mode !== 'off' && permitted) {
    const reservation = withLock(request.data_root, request.run_id, locked => {
      const current = loadRun(request.data_root, request.run_id); if (fs.existsSync(cacheFile)) return {cached: readJson(cacheFile)};
      const completed = new Set(current.events.filter(event => event.type === 'decision').map(event => event.payload?.decision_id));
      const unresolved = current.events.filter(event => event.type === 'decision_intent' && !completed.has(event.payload?.decision_id));
      if (unresolved.some(event => event.payload?.cache_key === key)) return {fallback_reason: 'decision_attempt_unknown'};
      const calls = current.events.filter(event => event.type === 'decision_intent').length;
      if (calls >= current.manifest.budget.max_decision_calls) return {fallback_reason: 'decision_call_limit'};
      appendEvent(locked, {type: 'decision_intent', payload: {decision_id: decisionId, kind, cache_key: key, provider: 'typesafe', model, policy_version: policy, usage_status: 'unknown_until_receipt'}}); return {reserved: true};
    });
    if (reservation.cached) outcome = {...reservation.cached, cached: true, cached_source_had_paid_attempt: !!reservation.cached.paid_attempt, paid_attempt: false};
    else if (reservation.fallback_reason) outcome.fallback_reason = reservation.fallback_reason;
    else shouldCall = reservation.reserved === true;
  } else if (manifest.decision_mode !== 'off') outcome.fallback_reason = !manifest.paid_api_enabled ? 'paid_api_disabled' : !apiKey ? 'missing_api_key' : 'missing_approved_api_budget';
  if (shouldCall) {
    try {
      const response = await typesafeDecision({model, state, questions, apiKey, fetchImpl: deps.fetchImpl || fetch, timeout_ms: request.timeout_ms || 10_000});
      const low = Object.values(response.answers).some(a => a.confidence < (request.confidence_threshold ?? 0.75));
      outcome = low ? {provider: 'rules', model: null, result: baseline, fallback_reason: 'low_confidence_uncalibrated', measurement: response.usage ? 'measured' : 'unavailable', provider_usage: response.usage, paid_attempt: true, cacheable: true} : {provider: 'typesafe', model, result: response, fallback_reason: null, measurement: response.usage ? 'measured' : 'unavailable', provider_usage: response.usage, paid_attempt: true, cacheable: true};
    } catch (error) { outcome = {provider: 'rules', model: null, result: baseline, fallback_reason: error.code || 'provider_error', measurement: 'unavailable', provider_usage: null, paid_attempt: true, cacheable: false}; }
  }
  const applied = active && outcome.provider === 'typesafe' ? outcome.result : baseline;
  return withLock(request.data_root, request.run_id, locked => {
    loadRun(request.data_root, request.run_id); if (shouldCall && outcome.cacheable) atomicJson(cacheFile, outcome);
    appendEvent(locked, {type: 'decision', payload: {decision_id: decisionId, kind, cache_key: key, provider: outcome.provider, model: outcome.model, cached: !!outcome.cached, paid_attempt: !!outcome.paid_attempt, policy_version: policy, threshold: request.confidence_threshold ?? 0.75, decision_mode: manifest.decision_mode, shadow_proposal: shadow ? outcome.result : null, applied, fallback_reason: outcome.fallback_reason, provenance: {documentation_url: 'https://docs.typesafe.ai/api', documentation_checked_at: '2026-09-22'}}});
    const providerUsage = outcome.paid_attempt ? outcome.provider_usage : null;
    if (outcome.paid_attempt) appendEvent(locked, {type: 'usage', payload: {usage_id: `typesafe-${decisionId}`, provider: 'typesafe', model, input_tokens: providerUsage?.input_tokens ?? null, output_tokens: providerUsage?.output_tokens ?? null, cached_input_tokens: providerUsage?.cached_input_tokens ?? null, reasoning_tokens: providerUsage?.reasoning_tokens ?? null, unit: 'tokens', source: providerUsage ? 'provider_response' : 'provider_attempt_without_usage', measurement: providerUsage ? 'measured' : 'unavailable', status: providerUsage ? 'measured' : 'unavailable', cached: false, cache_key: key}});
    return {ok: true, decision_id: decisionId, applied, proposal: outcome.result, provider: outcome.provider, fallback_reason: outcome.fallback_reason, cached: !!outcome.cached};
  });
}

function safeMermaid(text) { return String(text).replace(/[^A-Za-z0-9_. -]/g, '_').slice(0, 80) || 'node'; }
function unresolvedDecisionIntents(events) { const completed = new Set(events.filter(event => event.type === 'decision').map(event => event.payload?.decision_id)); return events.filter(event => event.type === 'decision_intent' && !completed.has(event.payload?.decision_id)); }
function renderReport(manifest, events, state, packet) {
  const statuses = manifest.nodes.map(n => ({id: n.node_id, status: state.nodes[n.node_id].status})); const edges = manifest.nodes.flatMap(n => n.depends_on.map(d => `  ${safeMermaid(d)}["${safeMermaid(d)}: ${safeMermaid(state.nodes[d].status)}"] --> ${safeMermaid(n.node_id)}["${safeMermaid(n.node_id)}: ${safeMermaid(state.nodes[n.node_id].status)}"]`));
  const standalone = manifest.nodes.filter(n => !n.depends_on.length).map(n => `  ${safeMermaid(n.node_id)}["${safeMermaid(n.node_id)}: ${safeMermaid(state.nodes[n.node_id].status)}"]`);
  const allUsage = usage(events), decisions = events.filter(e => e.type === 'decision').map(e => e.payload), decisionUnknown = unresolvedDecisionIntents(events), retries = events.filter(e => e.type === 'retry_authorized'), failures = events.filter(e => ['node_result', 'attempt_reconciled'].includes(e.type) && e.payload?.status !== 'passed'); const allTerminal = manifest.nodes.every(n => TERMINAL.has(state.nodes[n.node_id].status)); const endedAt = allTerminal ? [...events].reverse().find(e => ['node_result', 'attempt_reconciled', 'node_invalidated'].includes(e.type))?.at ?? manifest.created_at : now(); const runMs = Math.max(0, Date.parse(endedAt) - Date.parse(manifest.created_at));
  const nodeTimes = manifest.nodes.map(n => { const start = state.nodes[n.node_id].attempts[0]?.started_at; const end = [...events].reverse().find(e => ['node_result', 'attempt_reconciled'].includes(e.type) && e.node_id === n.node_id)?.at; return {id: n.node_id, milliseconds: start && end ? Math.max(0, Date.parse(end) - Date.parse(start)) : null}; });
  const workMs = nodeTimes.reduce((sum, item) => sum + (item.milliseconds ?? 0), 0);
  return `# Graf - przebieg ${manifest.run_id}\n\nStan jest odtwarzany z trwałego łańcucha zdarzeń. Nieznana praca natywnego agenta nigdy nie jest oznaczana jako zakończona.\n\n\`\`\`mermaid\ngraph TD\n${[...standalone, ...edges].join('\n')}\n\`\`\`\n\n## Kroki i dowody\n\n| Krok | Status | Próby | Snapshoty dowodów | Czas intent-terminal ms |\n| --- | --- | ---: | --- | ---: |\n${manifest.nodes.map(n => `| ${n.node_id} | ${state.nodes[n.node_id].status} | ${state.nodes[n.node_id].attempts.length} | ${state.nodes[n.node_id].evidence.map(x => x.snapshot).join(', ')} | ${nodeTimes.find(x => x.id === n.node_id).milliseconds ?? 'null'} |`).join('\n')}\n\n## Kontekst\n\n- Packet: ${packet.packet_id}; selected source bytes=${packet.used_source_bytes}; candidate source bytes=${packet.candidate_source_bytes}; selected final message max=${packet.message_size?.selected_final_max ?? null} UTF-8 B; method=${packet.message_size?.method ?? 'unavailable'}.\n- Candidate messages: ${JSON.stringify(packet.message_size?.candidate_by_node ?? null)}; selected final messages: ${JSON.stringify(packet.message_size?.selected_final_by_node ?? null)}.\n- Token estimate=${packet.estimated_tokens} (${packet.token_estimate_method}, status=${packet.token_estimate_status ?? 'estimated'}).\n- Źródła: mandatory=${packet.source_counts.mandatory}, optional=${packet.source_counts.optional}, omitted=${packet.source_counts.omitted}.\n${packet.omitted.length ? packet.omitted.map(item => `- Pominięto ${item.id}: ${item.reason}.`).join('\n') : '- Brak pominiętych kandydatów.'}\n\n## Pomiar\n\n- Czas całego przebiegu: ${runMs} ms [measured, wall_clock, end=${endedAt}].\n- Suma odstępów intent-terminal kroków: ${workMs} ms [measured, elapsed; nie jest czystym czasem pracy].\n- Czas pracy modeli: null [unavailable: adapter nie raportuje osobnego czasu pracy].\n- Oczekiwanie kolejki: null [unavailable: adapter nie raportuje kolejki].\n- Ścieżka krytyczna: null [unavailable: Graf v1 nie ma osobnych okien wait/work].\n- Zużycie providera: ${allUsage.length ? `${allUsage.length} unikalne rekordy` : 'null [unavailable: brak telemetryki providera]'}.\n- Nierozliczone płatne intencje: ${decisionUnknown.length}; usage=null [unavailable] dla: ${decisionUnknown.map(e => e.payload.decision_id).join(', ') || 'brak'}. Każda nadal zajmuje limit wywołań i nie jest automatycznie ponawiana.\n- Koszt API: null [unavailable: Graf nie ma zatwierdzonego cennika ani raportowanego kosztu].\n- Koszt abonamentu/konta: null [unavailable: procenty limitów konta nie są kosztem zadania].\n\n${allUsage.length ? allUsage.map(u => `- usage ${u.usage_id}: input=${u.input_tokens ?? null}, output=${u.output_tokens ?? null}, cached_input=${u.cached_input_tokens ?? null}, reasoning=${u.reasoning_tokens ?? null}, źródło=${u.source}, status=${u.status ?? u.measurement}, unit=${u.unit ?? 'tokens'}.`).join('\n') : ''}\n\n## Decyzje, błędy i ponowienia\n\n- Decyzje: ${decisions.length}; fallbacki: ${decisions.filter(d => d.fallback_reason).length}; cache: ${decisions.filter(d => d.cached).length}.\n- Błędy/zakończenia nie-passed: ${failures.length}. ${failures.map(e => `${e.node_id}/${e.attempt_id}:${e.payload.status}`).join(', ') || 'brak'}\n- Retry: ${retries.length}. ${retries.map(e => `${e.node_id}/${e.attempt_id}`).join(', ') || 'brak'}\n${decisions.length ? decisions.map(d => `- ${d.decision_id}: provider=${d.provider}, proposed=${JSON.stringify(d.shadow_proposal ?? d.applied)}, applied=${JSON.stringify(d.applied)}, fallback=${d.fallback_reason ?? 'null'}, paid_attempt=${!!d.paid_attempt}.`).join('\n') : '- Brak decyzji. Wariant bazowy działa bez Jeva.'}\n\n## Integralność\n\n- Pochodzenie base_commit: ${manifest.base_provenance?.status ?? 'unknown'}; requested=${manifest.base_commit}; resolved=${manifest.base_provenance?.resolved_base ?? 'null'}; prepared HEAD=${manifest.base_provenance?.prepared_head ?? 'null'}; reason=${manifest.base_provenance?.reason ?? 'null'}.\n- Hash manifestu bazowego: \`${manifest.integrity_hash}\`.\n- Ostatnie zdarzenie: \`${events.at(-1)?.hash ?? 'none'}\`.\n- Bazowe hashe wejść są zachowane oddzielnie od zaakceptowanych efektów i świeżych packetów.\n`;
}
export function report(request) { return withLock(request.data_root, request.run_id, () => reportLocked(request)); }
function reportLocked(request) {
  const {dir, manifest, events} = loadRun(request.data_root, request.run_id, {allowCatchup: request.safe_checkpoint_catchup === true}); invalidateDrift(dir, manifest, events); const refreshed = loadRun(request.data_root, request.run_id); const state = deriveState(refreshed.manifest, refreshed.events); const prose = renderReport(refreshed.manifest, refreshed.events, state, latestPacket(refreshed.dir));
  atomicJson(path.join(refreshed.dir, 'result.json'), {run_id: request.run_id, generated_at: now(), statuses: state.nodes}); atomicText(path.join(refreshed.dir, 'report.md'), prose);
  const root = resultsDir(request.data_root); const release = acquireLock(root); try { const index = path.join(root, 'index.md'); const marker = `<!-- graf-managed:${request.run_id} -->`; const previous = fs.existsSync(index) ? fs.readFileSync(index, 'utf8') : '# Graf results\n'; const line = `${marker}\n- [${request.run_id}](../runs/${request.run_id}/report.md)\n<!-- /graf-managed:${request.run_id} -->`; const cleaned = previous.replace(new RegExp(`${marker}[\\s\\S]*?<!-- /graf-managed:${request.run_id} -->\\r?\\n?`, 'g'), ''); atomicText(index, `${cleaned.trimEnd()}\n\n${line}\n`); } finally { release(); }
  return {ok: true, report: path.join(refreshed.dir, 'report.md'), index: path.join(root, 'index.md'), statuses: Object.fromEntries(Object.entries(state.nodes).map(([id, n]) => [id, n.status]))};
}
export function resume(request) { return withLock(request.data_root, request.run_id, () => resumeLocked(request)); }
function resumeLocked(request) {
  const {dir, manifest, events} = loadRun(request.data_root, request.run_id, {allowCatchup: request.safe_checkpoint_catchup === true}); const drift = invalidateDrift(dir, manifest, events); const loaded = loadRun(request.data_root, request.run_id), state = deriveState(loaded.manifest, loaded.events);
  const reconciliation = currentRunning(state).map(([node_id, n]) => ({node_id, attempt_id: n.attempts.at(-1)?.attempt_id, operation: 'reconcile', action: 'reconcile_native_agent', effect_schema: {effect_checked: true, reconciliation_evidence: ['native terminal/not-started evidence'], effects: [{path: 'predeclared write_path', before: {exists: true, sha256: 'dispatch baseline'}, after: {exists: true, sha256: 'current filesystem'}}]}, terminal_statuses: ['failed', 'blocked', 'cancelled', 'timeout'], auto_replay: false}));
  const decision_reconciliation = unresolvedDecisionIntents(loaded.events).map(event => ({decision_id: event.payload.decision_id, cache_key: event.payload.cache_key, status: 'unknown', usage: null, usage_status: 'unavailable', consumes_call_budget: true, auto_replay: false}));
  return {ok: true, run_id: request.run_id, drift, reconciliation, decision_reconciliation, next: reconciliation.length ? [] : nextLocked(request).ready};
}
export function probe() { return {ok: true, tool: 'graf', version: VERSION, client: 'codex-desktop', adapter: 'native-handoff-v1', execution: 'CLI persists intents; caller invokes only returned collaboration.spawn_agent actions and records real receipts/results', native_action_tools: ['collaboration.spawn_agent'], decision_scope: {modes: ['off', 'shadow'], typesafe_questions: ['choice']}, implemented: ['prepare', 'next', 'dispatch', 'ack', 'record', 'reconcile', 'retry', 'resume', 'report', 'decide', 'probe']}; }
