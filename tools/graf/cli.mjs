#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
import {ack, decide, dispatch, GrafError, next, prepare, probe, reconcile, record, report, resume, retry} from './index.mjs';

const operations = {prepare, next, dispatch, ack, record, reconcile, retry, resume, report, decide, probe};
async function main(argv) {
  const operation = argv[2]; if (!operations[operation]) throw new GrafError('USAGE', 'Use one of: prepare, next, dispatch, ack, record, reconcile, retry, resume, report, decide, probe');
  let request = {};
  if (operation !== 'probe') {
    const flag = argv.indexOf('--request'); if (flag < 0 || !argv[flag + 1]) throw new GrafError('USAGE', 'Use --request <json-file>; inline JSON is intentionally unsupported');
    try { request = JSON.parse(fs.readFileSync(argv[flag + 1], 'utf8')); } catch (error) { throw new GrafError('INVALID_REQUEST_FILE', 'Cannot parse request JSON', {cause: error.message}); }
  }
  const result = await operations[operation](request); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
main(process.argv).catch(error => { const known = error instanceof GrafError; process.stderr.write(`${JSON.stringify({ok: false, code: known ? error.code : 'UNEXPECTED', error: error.message, details: known ? error.details : undefined})}\n`); process.exitCode = 1; });
