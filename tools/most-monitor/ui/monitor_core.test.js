'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    accountFresh,
    usageRows,
    scopeText,
    historyGroups,
    worstUsageRow
} = require('./monitor_core.js');

function snapshot(account) {
    return { accounts: [account] };
}

test('null usage stays null, never zero', () => {
    const rows = usageRows(snapshot({
        status: 'fresh', validUntil: 200,
        windows: [{ poolId: 'p', windowId: 'w', value: null, resetsAt: 300 }]
    }), 100);
    assert.equal(rows[0].usedPercent, null);
});

test('a missing validity deadline never turns an old sample into fresh UI data', () => {
    const account = { status: 'fresh', validUntil: null, windows: [{ resetsAt: 300 }] };
    assert.equal(accountFresh(account, 100), false);
    assert.equal(usageRows(snapshot(account), 100)[0].fresh, false);
});

test('expiry, reset, and cached collector error make data non-fresh', () => {
    assert.equal(accountFresh({ status: 'fresh', validUntil: 99, windows: [{ resetsAt: 300 }] }, 100), false);
    assert.equal(accountFresh({ status: 'fresh', validUntil: 300, windows: [{ resetsAt: 99 }] }, 100), false);
    assert.equal(accountFresh({ status: 'error', validUntil: 300, windows: [{ resetsAt: 400 }] }, 100), false);
});

test('a scoped tile picks the highest actual window instead of hiding it after two rows', () => {
    const row = worstUsageRow(snapshot({
        status: 'fresh', validUntil: 300,
        windows: [
            { poolId: 'all', windowId: 'short', usedPercent: 12, resetsAt: 400, scope: {} },
            { poolId: 'claude', windowId: 'week', usedPercent: 97, resetsAt: 400, scope: { models: ['claude-fable-97'] } }
        ]
    }), 100);
    assert.equal(row.poolId, 'claude');
    assert.equal(scopeText(row.scope), 'models: [claude-fable-97]');
});

test('history uses monitor snake_case rows and keeps pools in separate charts', () => {
    const groups = historyGroups([
        { provider: 'codex', account_ref: 'a', pool_id: 'all', window_id: 'week', scope: '{}', segment: 'one', observed_at: 300, received_at: 301, value: 70, status: 'fresh' },
        { provider: 'codex', account_ref: 'a', pool_id: 'all', window_id: 'week', scope: '{}', segment: 'one', observed_at: 100, received_at: 101, value: 40, status: 'fresh' },
        { provider: 'claude', account_ref: 'a', pool_id: 'fable', window_id: 'week', scope: '{"models":["claude-fable-97"]}', segment: 'one', observed_at: 200, received_at: 201, value: 97, status: 'fresh' }
    ]);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.find((group) => group.poolId === 'all').rows.map((row) => row.value), [40, 70]);
    assert.equal(groups.find((group) => group.poolId === 'fable').rows[0].value, 97);
});
