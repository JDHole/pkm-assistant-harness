'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    accountFresh,
    usageRows,
    codexUsageRows,
    scopeText,
    historyGroups,
    worstUsageRow
} = require('./monitor_core.js');

function snapshot(account) {
    return { accounts: [account] };
}

function loadMainWithObsidianStub() {
    const Module = require('node:module');
    const originalLoad = Module._load;
    const obsidian = {
        Plugin: class {}, Menu: class {}, Modal: class {}, Notice: class {},
        requestUrl: async () => ({ status: 200, json: {} })
    };
    Module._load = function load(request, parent, isMain) {
        if (request === 'obsidian') return obsidian;
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[require.resolve('./main.js')];
        return require('./main.js');
    } finally {
        Module._load = originalLoad;
    }
}

class FakeElement {
    constructor(tag, cls = '') {
        this.tagName = tag;
        this.cls = cls;
        this.children = [];
        this.attributes = {};
        this.style = {};
        this.textContent = '';
        this.isConnected = false;
    }
    createEl(tag, options = {}) {
        const child = new FakeElement(tag, options.cls || '');
        this.children.push(child);
        return child;
    }
    setText(text) { this.textContent = text; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener() {}
    empty() { this.children = []; }
    descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
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

test('Obsidian status only reports fresh Codex/Work usage, clearly as used percent', () => {
    const { usageStatusText } = require('./monitor_core.js');
    const data = { accounts: [
        { provider: 'codex', label: 'Codex', status: 'fresh', observedAt: 100, validUntil: 250, coverage: ['Codex/Work'], windows: [
            { poolId: 'all', windowId: 'short', label: '5-hour', windowMinutes: 300, usedPercent: 3, resetsAt: 240 }
        ] },
        { provider: 'claude', label: 'Claude', status: 'fresh', observedAt: 100, validUntil: 250, windows: [
            { poolId: 'claude', windowId: 'week', usedPercent: 91, resetsAt: 240 }
        ] }
    ] };
    assert.equal(usageStatusText(data, 100), 'Codex/Work 3% użyte (5 h)');
    assert.match(usageStatusText(data, 100, 'offline'), /błąd monitora/);
    assert.match(usageStatusText({ accounts: [{ ...data.accounts[0], validUntil: 99 }] }, 100), /odczyt nieświeży/);
    assert.equal(usageStatusText({ accounts: [data.accounts[1]] }, 100), 'Codex/Work: brak danych w monitorze');
});

test('status dot warns when quota monitor data is stale or its request failed', () => {
    const { statusBarLevel } = require('./monitor_core.js');
    const fresh = { accounts: [{ provider: 'codex', status: 'fresh', observedAt: 100, validUntil: 300, windows: [{ usedPercent: 3, resetsAt: 400 }] }] };
    const stale = { accounts: [{ provider: 'codex', status: 'fresh', observedAt: 100, validUntil: 99, windows: [{ usedPercent: 3, resetsAt: 400 }] }] };
    assert.equal(statusBarLevel({ state: 'ok' }, fresh, 100, null), 'ok');
    assert.equal(statusBarLevel({ state: 'ok' }, stale, 100, null), 'warn');
    assert.equal(statusBarLevel({ state: 'down' }, fresh, 100, null), 'down');
    assert.equal(statusBarLevel({ state: 'ok' }, fresh, 100, 'offline'), 'warn');
});

test('old observations and mixed windows stay explicitly stale instead of looking green', () => {
    const { usageStatusText, statusBarLevel } = require('./monitor_core.js');
    const mixed = { accounts: [{ provider: 'codex', status: 'fresh', observedAt: 800, validUntil: 2000, windows: [
        { label: '5-hour', windowMinutes: 300, usedPercent: 4, resetsAt: 1500 },
        { label: 'expired', windowMinutes: 60, usedPercent: 70, resetsAt: 999 },
        { label: 'unknown', windowMinutes: 90, usedPercent: null, resetsAt: 1500 }
    ] }] };
    const text = usageStatusText(mixed, 1000);
    assert.match(text, /Codex\/Work 4% użyte \(5 h\)/);
    assert.match(text, /expired: odczyt nieświeży/);
    assert.match(text, /unknown: brak odczytu/);
    assert.equal(statusBarLevel({ state: 'ok' }, mixed, 1000), 'warn');
    assert.equal(accountFresh({ status: 'fresh', observedAt: 600, validUntil: 2000, windows: [{ resetsAt: 1500 }] }, 1000), false);
});

test('cached fresh samples become visibly errored in presentation after transport failure', () => {
    const { usageStatusText, displayFreshness } = require('./monitor_core.js');
    const sample = { fresh: true, usedPercent: 4 };
    assert.equal(displayFreshness(sample), 'fresh');
    assert.equal(displayFreshness(sample, 'offline'), 'error');
    assert.equal(usageStatusText({ accounts: [{ provider: 'codex', status: 'fresh', observedAt: 100, validUntil: 200, windows: [sample] }] }, 110, 'offline'), 'Codex/Work: błąd monitora · ostatni zapis');
});

test('Home and modal render cached fresh values as errors after a monitor request fails', () => {
    const { __test, default: unused } = (() => {
        const plugin = loadMainWithObsidianStub();
        return { __test: plugin.__test, default: plugin };
    })();
    const row = { poolId: 'all', windowId: 'short', label: '5h', windowMinutes: 300, usedPercent: 4, resetsAt: 1500, scope: {} };
    const account = { provider: 'codex', label: 'Codex/Work', status: 'fresh', observedAt: 100, validUntil: 2000, windows: [row] };
    const modalParent = new FakeElement('section');
    __test.renderWindow(modalParent, account, { ...row, fresh: true, accountStatus: 'fresh' }, 110, 'offline');
    const modalState = modalParent.descendants().find((node) => node.tagName === 'small' && node.cls.includes('most-usage-stale'));
    assert.match(modalState.textContent, /błąd monitora/);

    const PluginClass = unused;
    const tilePlugin = {
        usageSnapshot: { accounts: [account] }, usageError: 'offline', unloaded: false,
        subscribeUsage(callback) { callback(this.usageSnapshot, this.usageError); return () => {}; },
        fetchUsage() {}, openUsagePanel() {}
    };
    const container = new FakeElement('div');
    PluginClass.prototype.renderUsageTile.call(tilePlugin, container, null);
    const tile = container.children[0];
    const heading = tile.children.find((node) => node.tagName === 'strong');
    const tileState = tile.children.find((node) => node.cls.includes('most-usage-tile-stale'));
    assert.match(heading.textContent, /błąd monitora/);
    assert.match(tileState.textContent, /błąd monitora/);
    assert.match(tile.attributes.title, /błąd monitora/);
});

test('Codex account errors without windows never fall back to bridge quota or look green', () => {
    const { usageStatusText, statusBarLevel } = require('./monitor_core.js');
    const failed = { accounts: [{ provider: 'codex', status: 'error', windows: [] }] };
    assert.equal(usageStatusText(failed, 100), 'Codex/Work: błąd odczytu');
    assert.equal(usageStatusText(null, 100), 'Codex/Work: czekam na monitor');
    assert.equal(statusBarLevel({ state: 'ok', usage: { weekly_used_percent: 91 } }, failed, 100), 'warn');
});

test('Codex-only row selector excludes Claude pools', () => {
    const rows = codexUsageRows({ accounts: [
        { provider: 'codex', windows: [{ windowId: 'w', usedPercent: 3 }] },
        { provider: 'claude', windows: [{ windowId: 'c', usedPercent: 91 }] }
    ] }, 100);
    assert.deepEqual(rows.map((row) => row.provider), ['codex']);
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
