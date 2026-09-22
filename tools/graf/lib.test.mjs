import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {ack, decide, dispatch, GrafError, next, prepare, probe, reconcile, record, report, resume, retry, sha256} from './index.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graf-test-')); const repo = path.join(root, 'repo'); const data_root = path.join(root, 'data'); fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'input.txt'), 'alpha\nβeta\n', 'utf8');
  const base = {data_root, run_id: 'run', task: 'Test the bounded coordinator.', acceptance_criteria: ['An evidence file exists.'], repo, base_commit: 'a'.repeat(40), allow_unverified_base_commit: true, context: {max_input_bytes: 48000, mandatory: [{path: 'input.txt', range: {start: 1, end: 1}}], candidates: []}, nodes: [{node_id: 'write', kind: 'implementation', goal: 'Write a result.', depends_on: [], required: true, input_refs: [{path: 'input.txt'}], output_contract: {type: 'result'}, acceptance: ['A result exists.'], write_scope: 'repo', write_paths: ['input.txt'], executor: 'terra', model: 'gpt-5.6-terra', effort: 'medium', timeout_seconds: 60, max_attempts: 2}, {node_id: 'review', kind: 'review', goal: 'Review independently.', depends_on: ['write'], required: true, input_refs: [{path: 'input.txt'}], output_contract: {type: 'review'}, acceptance: ['Review result.'], write_scope: 'read-only', executor: 'sol', model: 'gpt-5.6-sol', effort: 'high', timeout_seconds: 60, max_attempts: 1, reviewer_for: 'write'}]};
  return {root, repo, data_root, base};
}
function resultFile(f) { const file = path.join(f.root, 'result.txt'); fs.writeFileSync(file, 'green', 'utf8'); return {path: file, sha256: sha256(fs.readFileSync(file))}; }
function expectedError(fn, code) { assert.throws(fn, error => error instanceof GrafError && error.code === code); }
function effect(pathname, beforeText, afterText) { return {path: pathname, before: {exists: true, sha256: sha256(Buffer.from(beforeText))}, after: {exists: true, sha256: sha256(Buffer.from(afterText))}}; }
function truncateJournal(dir, predicate) {
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); const index = events.findIndex(predicate); assert.ok(index >= 0); const kept = events.slice(0, index + 1); fs.writeFileSync(path.join(dir, 'events.jsonl'), `${kept.map(item => JSON.stringify(item)).join('\n')}\n`); fs.writeFileSync(path.join(dir, 'checkpoint.json'), `${JSON.stringify({seq: kept.length, hash: kept.at(-1).hash})}\n`); return kept.at(-1);
}

test('prepare validates cycles, dependencies and mandatory context', () => {
  const f = fixture(); const cyclic = structuredClone(f.base); cyclic.nodes[0].depends_on = ['review']; expectedError(() => prepare(cyclic), 'CYCLE');
  const missing = fixture(); missing.base.context.mandatory = [{path: 'none.txt'}]; expectedError(() => prepare(missing.base), 'MISSING_MANDATORY_CONTEXT');
  const overflow = fixture(); overflow.base.context.max_input_bytes = 1; expectedError(() => prepare(overflow.base), 'MANDATORY_CONTEXT_OVERFLOW');
});

test('native receipt, evidence snapshot, reviewer gate and report work', () => {
  const f = fixture(); const prepared = prepare(f.base); assert.equal(prepared.ok, true); assert.equal(next({data_root: f.data_root, run_id: 'run'}).ready[0].node_id, 'write');
  const d = dispatch({data_root: f.data_root, run_id: 'run', node_id: 'write', executor_identity: 'implementer'}); assert.equal(d.native_action.args.fork_turns, 'none'); assert.match(d.native_action.args.task_name, /^graf_/);
  ack({data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, receipt_id: 'r1', tool_agent_id: 'agent-1', executor_identity: 'implementer'});
  assert.equal(ack({data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, receipt_id: 'r1', tool_agent_id: 'agent-1'}).idempotent, true);
  const r = record({data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, status: 'passed', executor_identity: 'agent-1', evidence: [resultFile(f)]}); assert.match(r.evidence[0].snapshot, /^evidence\//);
  const review = dispatch({data_root: f.data_root, run_id: 'run', node_id: 'review', executor_identity: 'reviewer'}); ack({data_root: f.data_root, run_id: 'run', node_id: 'review', attempt_id: review.attempt_id, receipt_id: 'r2', tool_agent_id: 'agent-2'});
  record({data_root: f.data_root, run_id: 'run', node_id: 'review', attempt_id: review.attempt_id, status: 'passed', executor_identity: 'agent-2', evidence: [resultFile(f)]});
  const rep = report({data_root: f.data_root, run_id: 'run'}); assert.equal(rep.statuses.review, 'passed'); assert.match(fs.readFileSync(rep.report, 'utf8'), /mermaid/);
});

test('writer reservation is cross-run and an unknown receipt is never replayed', () => {
  const f = fixture(); prepare(f.base); const d = dispatch({data_root: f.data_root, run_id: 'run', node_id: 'write'}); expectedError(() => dispatch({data_root: f.data_root, run_id: 'run', node_id: 'write'}), 'NOT_DISPATCHABLE'); assert.equal(resume({data_root: f.data_root, run_id: 'run'}).reconciliation[0].auto_replay, false); ack({data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, receipt_id: 'r1', tool_agent_id: 'native-1'});
  const other = structuredClone(f.base); other.run_id = 'other'; prepare(other); assert.equal(next({data_root: f.data_root, run_id: 'other'}).ready.length, 0);
  const resumed = resume({data_root: f.data_root, run_id: 'run'}); assert.equal(resumed.reconciliation[0].auto_replay, false);
});

test('retry is explicit after a terminal result and preserves native identity', () => {
  const f = fixture(); prepare(f.base); const first = dispatch({data_root: f.data_root, run_id: 'run', node_id: 'write'}); ack({data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: first.attempt_id, receipt_id: 'r1', tool_agent_id: 'native-1'});
  expectedError(() => record({data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: first.attempt_id, status: 'failed', executor_identity: 'alias'}), 'EXECUTOR_IDENTITY_MISMATCH');
  record({data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: first.attempt_id, status: 'failed', executor_identity: 'native-1'});
  expectedError(() => retry({data_root: f.data_root, run_id: 'run', node_id: 'write', previous_attempt_id: first.attempt_id, effect_checked: true}), 'RECONCILIATION_EVIDENCE_REQUIRED');
  retry({data_root: f.data_root, run_id: 'run', node_id: 'write', previous_attempt_id: first.attempt_id, effect_checked: true, reconciliation_evidence: ['checked native result: failed']}); assert.equal(next({data_root: f.data_root, run_id: 'run'}).ready[0].node_id, 'write');
});

test('checkpoint corruption, torn tail and truncation fail closed', () => {
  const f = fixture(); prepare(f.base); const dir = path.join(f.data_root, 'runs', 'run'); const log = path.join(dir, 'events.jsonl'); fs.appendFileSync(log, '{'); expectedError(() => next({data_root: f.data_root, run_id: 'run'}), 'TORN_LOG');
  const g = fixture(); prepare(g.base); const gd = path.join(g.data_root, 'runs', 'run'); fs.writeFileSync(path.join(gd, 'events.jsonl'), ''); expectedError(() => next({data_root: g.data_root, run_id: 'run'}), 'TRUNCATED_LOG');
});

test('source drift invalidates a passed result and its dependent gate', () => {
  const f = fixture(); prepare(f.base); const d = dispatch({data_root: f.data_root, run_id: 'run', node_id: 'write'}); ack({data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, receipt_id: 'r1', tool_agent_id: 'a'}); record({data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, status: 'passed', executor_identity: 'a', evidence: [resultFile(f)]});
  fs.writeFileSync(path.join(f.repo, 'input.txt'), 'changed'); const state = next({data_root: f.data_root, run_id: 'run'}); assert.equal(state.ready.length, 0); assert.deepEqual(state.drift, ['input.txt']);
});

test('typesafe fake validates malformed, low confidence, shadow and cache', async () => {
  const f = fixture(); f.base.decision_mode = 'shadow'; f.base.paid_api_enabled = true; prepare(f.base); const questions = {q: {type: 'choice', instructions: 'classify', criteria: {simple: 'small task', standard: 'usual task', complex: 'large task', unknown: 'insufficient context'}}};
  const fake = async () => ({ok: true, json: async () => ({model: 'jev-1.13.0', answers: {q: {type: 'choice', choice: 'complex', probabilities: {simple: 0.1, standard: 0.1, complex: 0.7, unknown: 0.1}, confidence: 0.8}}, usage: {input_tokens: 3, output_tokens: 1}})});
  const one = await decide({data_root: f.data_root, run_id: 'run', kind: 'delegation', state: {x: 1}, questions, api_key: 'fake', approved_api_budget: 1}, {fetchImpl: fake}); assert.equal(one.provider, 'typesafe'); assert.equal(one.applied.chosen, 'standard');
  const two = await decide({data_root: f.data_root, run_id: 'run', kind: 'delegation', state: {x: 1}, questions, api_key: 'fake', approved_api_budget: 1}, {fetchImpl: async () => { throw new Error('should cache'); }}); assert.equal(two.cached, true);
  const low = await decide({data_root: f.data_root, run_id: 'run', kind: 'delegation', state: {x: 2}, questions, api_key: 'fake', approved_api_budget: 1}, {fetchImpl: async () => ({ok: true, json: async () => ({model: 'jev-1.13.0', answers: {q: {type: 'choice', choice: 'simple', probabilities: {simple: 1, standard: 0, complex: 0, unknown: 0}, confidence: 0.1}}, usage: {input_tokens: 1, output_tokens: 1}})})}); assert.equal(low.fallback_reason, 'low_confidence_uncalibrated');
  const malformed = await decide({data_root: f.data_root, run_id: 'run', kind: 'delegation', state: {x: 3}, questions, api_key: 'fake', approved_api_budget: 1}, {fetchImpl: async () => ({ok: true, json: async () => ({model: 'wrong', answers: {}})})}); assert.equal(malformed.fallback_reason, 'MALFORMED_PROVIDER_RESPONSE');
  const disabled = fixture(); disabled.base.decision_mode = 'shadow'; prepare(disabled.base); const off = await decide({data_root: disabled.data_root, run_id: 'run', kind: 'delegation', questions, state: {}, approved_api_budget: 1}); assert.equal(off.fallback_reason, 'paid_api_disabled');
});

test('budget refuses starts and CLI persists a prepared run', () => {
  const limited = fixture(); limited.base.budget = {max_agent_starts: 0}; prepare(limited.base); expectedError(() => dispatch({data_root: limited.data_root, run_id: 'run', node_id: 'write'}), 'AGENT_START_LIMIT');
  const f = fixture(); const request = path.join(f.root, 'request.json'); fs.writeFileSync(request, JSON.stringify(f.base)); const cli = path.resolve('tools/graf/cli.mjs'); const prepared = spawnSync(process.execPath, [cli, 'prepare', '--request', request], {encoding: 'utf8'}); assert.equal(prepared.status, 0, prepared.stderr); assert.equal(JSON.parse(prepared.stdout).ok, true);
  const nextRequest = path.join(f.root, 'next.json'); fs.writeFileSync(nextRequest, JSON.stringify({data_root: f.data_root, run_id: 'run'})); const following = spawnSync(process.execPath, [cli, 'next', '--request', nextRequest], {encoding: 'utf8'}); assert.equal(following.status, 0, following.stderr); assert.equal(JSON.parse(following.stdout).ready[0].node_id, 'write');
});

test('predeclared writer effect advances current inputs and downstream receives a fresh packet', () => {
  const f = fixture(); prepare(f.base); const d = dispatch({data_root: f.data_root, run_id: 'run', node_id: 'write'}); ack({data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, receipt_id: 'writer-receipt', tool_agent_id: 'writer-agent'});
  fs.writeFileSync(path.join(f.repo, 'input.txt'), 'beta\n', 'utf8'); const request = {data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, status: 'passed', executor_identity: 'writer-agent', evidence: [{path: path.join(f.repo, 'input.txt'), sha256: sha256(Buffer.from('beta\n'))}], effects: [effect('input.txt', 'alpha\nβeta\n', 'beta\n')]};
  const first = record(request); assert.equal(first.status, 'passed'); assert.equal(record(request).idempotent, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.data_root, 'runs', 'run', 'manifest.json'), 'utf8')); assert.equal(manifest.baseline_input_hashes.find(item => item.path === 'input.txt').sha256, sha256(Buffer.from('alpha\nβeta\n')));
  assert.equal(next({data_root: f.data_root, run_id: 'run'}).ready[0].node_id, 'review'); const review = dispatch({data_root: f.data_root, run_id: 'run', node_id: 'review'}); assert.match(review.native_action.args.message, /beta/); assert.doesNotMatch(review.native_action.args.message, /alpha/);
});

test('undeclared and unexpected effects stay quarantined', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.repo, 'other.txt'), 'stable', 'utf8'); f.base.nodes[0].input_refs.push({path: 'other.txt'}); prepare(f.base); const d = dispatch({data_root: f.data_root, run_id: 'run', node_id: 'write'}); ack({data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, receipt_id: 'r', tool_agent_id: 'agent'});
  fs.writeFileSync(path.join(f.repo, 'rogue.txt'), 'rogue', 'utf8'); expectedError(() => record({data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, status: 'failed', executor_identity: 'agent', effects: [{path: 'rogue.txt', before: {exists: false, sha256: null}, after: {exists: true, sha256: sha256(Buffer.from('rogue'))}}]}), 'UNDECLARED_EFFECT');
  fs.writeFileSync(path.join(f.repo, 'other.txt'), 'changed', 'utf8'); expectedError(() => record({data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, status: 'failed', executor_identity: 'agent', effects: []}), 'INPUT_DRIFT_QUARANTINED');
});

test('reconcile terminates an unknown partial writer effect and permits bounded retry', () => {
  const f = fixture(); prepare(f.base); const d = dispatch({data_root: f.data_root, run_id: 'run', node_id: 'write'}); fs.writeFileSync(path.join(f.repo, 'input.txt'), 'partial\n', 'utf8');
  reconcile({data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, status: 'failed', effect_checked: true, reconciliation_evidence: ['native task ended before receipt; filesystem inspected'], effects: [effect('input.txt', 'alpha\nβeta\n', 'partial\n')]});
  retry({data_root: f.data_root, run_id: 'run', node_id: 'write', previous_attempt_id: d.attempt_id, effect_checked: true, reconciliation_evidence: ['partial effect is now the accepted current baseline']}); assert.equal(next({data_root: f.data_root, run_id: 'run'}).ready[0].node_id, 'write');
});

test('receipt/result tuples and usage IDs are idempotent only when exact', () => {
  const f = fixture(); prepare(f.base); const d = dispatch({data_root: f.data_root, run_id: 'run', node_id: 'write'}); ack({data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, receipt_id: 'same', tool_agent_id: 'agent'});
  expectedError(() => ack({data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, receipt_id: 'same', tool_agent_id: 'other'}), 'RECEIPT_ID_CONFLICT');
  expectedError(() => record({data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, status: 'failed', executor_identity: 'agent', usage: [{usage_id: 'bad', input_tokens: null, output_tokens: 1, measurement: 'measured'}]}), 'INVALID_USAGE');
  const result = {data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, status: 'failed', executor_identity: 'agent', usage: [{usage_id: 'u1', provider: 'openai', model: 'x', input_tokens: 4, output_tokens: 2, cached_input_tokens: 1, reasoning_tokens: 1, measurement: 'measured', source: 'receipt', status: 'measured'}]}; record(result); assert.equal(record(result).idempotent, true); expectedError(() => record({...result, summary: 'different'}), 'RESULT_CONFLICT');
});

test('next stops offering work after the wall budget and off mode never fetches', async () => {
  const f = fixture(); f.base.budget = {max_minutes: 0}; f.base.paid_api_enabled = true; prepare(f.base); assert.equal(next({data_root: f.data_root, run_id: 'run'}).ready.length, 0);
  let fetched = false; const out = await decide({data_root: f.data_root, run_id: 'run', kind: 'delegation', state: {}, questions: {}, api_key: 'configured', approved_api_budget: 1}, {fetchImpl: async () => { fetched = true; throw new Error('must not run'); }}); assert.equal(fetched, false); assert.equal(out.provider, 'rules');
});

test('non-git provenance needs an explicit fixture opt-in and probe reports bounded native operations', () => {
  const f = fixture(); delete f.base.allow_unverified_base_commit; expectedError(() => prepare(f.base), 'BASE_COMMIT_UNVERIFIED'); const advertised = probe(); assert.deepEqual(advertised.native_action_tools, ['collaboration.spawn_agent']); assert.ok(advertised.implemented.includes('reconcile') && advertised.implemented.includes('retry'));
});

test('fresh CLI processes persist a real writer effect', () => {
  const f = fixture(), cli = path.resolve('tools/graf/cli.mjs'), invoke = (operation, request, name) => { const file = path.join(f.root, `${name}.json`); fs.writeFileSync(file, JSON.stringify(request)); const run = spawnSync(process.execPath, [cli, operation, '--request', file], {encoding: 'utf8'}); assert.equal(run.status, 0, run.stderr); return JSON.parse(run.stdout); };
  invoke('prepare', f.base, 'prepare'); const d = invoke('dispatch', {data_root: f.data_root, run_id: 'run', node_id: 'write'}, 'dispatch'); invoke('ack', {data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, receipt_id: 'cli-receipt', tool_agent_id: 'cli-agent'}, 'ack'); fs.writeFileSync(path.join(f.repo, 'input.txt'), 'cli-beta\n', 'utf8');
  const result = invoke('record', {data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, status: 'passed', executor_identity: 'cli-agent', evidence: [{path: path.join(f.repo, 'input.txt'), sha256: sha256(Buffer.from('cli-beta\n'))}], effects: [effect('input.txt', 'alpha\nβeta\n', 'cli-beta\n')]}, 'record'); assert.equal(result.status, 'passed'); assert.equal(next({data_root: f.data_root, run_id: 'run'}).ready[0].node_id, 'review');
});

test('concurrent paid decisions reserve the call budget before either fetch', async () => {
  const f = fixture(); f.base.variant = 'C'; f.base.decision_mode = 'shadow'; f.base.paid_api_enabled = true; f.base.budget = {max_decision_calls: 1}; prepare(f.base); let calls = 0;
  const questions = {q: {type: 'choice', instructions: 'choose', criteria: {a: 'A', b: 'B'}}}; const fake = async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 20)); return {ok: true, json: async () => ({model: 'jev-1.13.0', answers: {q: {type: 'choice', choice: 'a', probabilities: {a: 0.9, b: 0.1}, confidence: 0.9}}, usage: {input_tokens: 2, output_tokens: 1}})}; };
  const base = {data_root: f.data_root, run_id: 'run', kind: 'delegation', questions, api_key: 'fake', approved_api_budget: 1}; const results = await Promise.all([decide({...base, state: {request: 1}}, {fetchImpl: fake}), decide({...base, state: {request: 2}}, {fetchImpl: fake})]); assert.equal(calls, 1); assert.ok(results.some(item => item.fallback_reason === 'decision_call_limit'));
  const events = fs.readFileSync(path.join(f.data_root, 'runs', 'run', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); assert.equal(events.filter(item => item.type === 'decision_intent').length, 1);
});

test('repeated record completes packet, gate and writer release after crash boundaries', () => {
  const f = fixture(); prepare(f.base); const d = dispatch({data_root: f.data_root, run_id: 'run', node_id: 'write'}); ack({data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, receipt_id: 'crash-receipt', tool_agent_id: 'crash-agent'}); const reservation = path.join(f.data_root, 'writer-reservations', `${sha256(fs.realpathSync.native(f.repo))}.json`), reservationBody = fs.readFileSync(reservation);
  fs.writeFileSync(path.join(f.repo, 'input.txt'), 'after-crash\n', 'utf8'); const request = {data_root: f.data_root, run_id: 'run', node_id: 'write', attempt_id: d.attempt_id, status: 'passed', executor_identity: 'crash-agent', evidence: [{path: path.join(f.repo, 'input.txt'), sha256: sha256(Buffer.from('after-crash\n'))}], effects: [effect('input.txt', 'alpha\nβeta\n', 'after-crash\n')]}; record(request);
  const dir = path.join(f.data_root, 'runs', 'run'); truncateJournal(dir, event => event.type === 'effect_applied'); fs.writeFileSync(reservation, reservationBody); record(request);
  let events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); assert.ok(events.some(event => event.type === 'packet_refreshed')); assert.ok(events.some(event => event.type === 'gate')); assert.equal(fs.existsSync(reservation), false);
  truncateJournal(dir, event => event.type === 'node_result'); fs.writeFileSync(reservation, reservationBody); assert.equal(record(request).idempotent, true); events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); assert.ok(events.some(event => event.type === 'gate')); assert.equal(fs.existsSync(reservation), false);
});
