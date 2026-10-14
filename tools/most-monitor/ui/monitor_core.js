'use strict';

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const MAX_FRESH_AGE_SECONDS = 300;

function windowFresh(window, now) {
    return Boolean(window) && finite(now) && !(finite(window.resetsAt) && window.resetsAt <= now);
}

// A missing validity deadline is not evidence that a saved sample is still fresh.
function accountFresh(account, now) {
    return Boolean(account)
        && account.status === 'fresh'
        && finite(now)
        && finite(account.observedAt)
        && account.observedAt <= now + 5
        && now - account.observedAt <= MAX_FRESH_AGE_SECONDS
        && finite(account.validUntil)
        && account.validUntil > now
        && Array.isArray(account.windows)
        && account.windows.some((window) => windowFresh(window, now));
}

function usageRows(snapshot, now) {
    return ((snapshot && snapshot.accounts) || []).flatMap((account) => (
        (account.windows || []).map((window) => ({
            provider: account.provider,
            accountRef: account.accountRef,
            accountLabel: account.label,
            accountStatus: account.status,
            observedAt: account.observedAt,
            validUntil: account.validUntil,
            poolId: window.poolId,
            windowId: window.windowId,
            label: window.label,
            scope: window.scope,
            windowMinutes: window.windowMinutes,
            resetsAt: window.resetsAt,
            usedPercent: finite(window.usedPercent) ? window.usedPercent : (finite(window.value) ? window.value : null),
            fresh: accountFresh(account, now) && windowFresh(window, now)
        }))
    ));
}

function codexUsageRows(snapshot, now) {
    return usageRows(snapshot, now).filter((row) => row.provider === 'codex');
}

function displayFreshness(row, transportError = null) {
    if (transportError) return 'error';
    return row && row.fresh ? 'fresh' : 'stale';
}

function usageStatusText(snapshot, now, error = null) {
    const rows = codexUsageRows(snapshot, now);
    const fresh = rows.filter((row) => row.fresh && finite(row.usedPercent));
    if (error) return fresh.length ? 'Codex/Work: błąd monitora · ostatni zapis' : 'Codex/Work: błąd monitora';
    if (!snapshot) return 'Codex/Work: czekam na monitor';
    if (!rows.length) {
        const accounts = (snapshot.accounts || []).filter((account) => account.provider === 'codex');
        if (!accounts.length) return 'Codex/Work: brak danych w monitorze';
        const status = accounts[0].status;
        if (status === 'error') return 'Codex/Work: błąd odczytu';
        if (status === 'auth_required') return 'Codex/Work: wymaga logowania';
        if (status === 'unsupported') return 'Codex/Work: nieobsługiwane';
        if (status === 'unknown') return 'Codex/Work: stan nieznany';
        if (status === 'stale') return 'Codex/Work: odczyt nieświeży';
        return 'Codex/Work: brak okien użycia';
    }
    // Keep each provider window separate: their percentages have different resets/scopes.
    return rows.map((row) => {
        if (!row.fresh) return `${row.label || row.windowId || 'Codex/Work'}: odczyt nieświeży`;
        if (!finite(row.usedPercent)) return `${row.label || row.windowId || 'Codex/Work'}: brak odczytu`;
        const minutes = row.windowMinutes;
        let span = '';
        if (finite(minutes) && minutes > 0) {
            if (minutes % 1440 === 0) span = ` (${minutes / 1440} dni)`;
            else if (minutes % 60 === 0) span = ` (${minutes / 60} h)`;
            else span = ` (${minutes} min)`;
        }
        return `Codex/Work ${Math.round(row.usedPercent)}% użyte${span}`;
    }).join(' · ');
}

function statusBarLevel(status, snapshot, now, error = null) {
    const health = !status ? 'off' : status.state === 'down' ? 'down'
        : status.state === 'starting' || status.state === 'suspect' ? 'warn'
            : 'ok';
    if (health === 'down') return 'down';
    const rows = codexUsageRows(snapshot, now);
    if (error || !rows.length || rows.some((row) => !row.fresh || !finite(row.usedPercent))) return 'warn';
    if (rows.some((row) => row.usedPercent >= 80)) return 'warn';
    return health;
}

function stableValue(value) {
    if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${key}:${stableValue(value[key])}`).join(',')}}`;
    }
    return String(value == null ? '' : value);
}

function scopeText(scope) {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).length === 0) {
        return 'zakres nieznany';
    }
    return Object.keys(scope).sort().map((key) => `${key}: ${stableValue(scope[key])}`).join(' · ');
}

function historyScope(scope) {
    if (typeof scope !== 'string') return scope == null ? {} : scope;
    try {
        const parsed = JSON.parse(scope);
        return parsed && typeof parsed === 'object' ? parsed : { value: scope };
    } catch (_) {
        return { value: scope };
    }
}

function historyRow(row) {
    const source = row || {};
    return {
        provider: source.provider || '',
        accountRef: source.account_ref || source.accountRef || '',
        poolId: source.pool_id || source.poolId || '',
        windowId: source.window_id || source.windowId || '',
        scope: historyScope(source.scope),
        segment: source.segment || '',
        observedAt: finite(source.observed_at) ? source.observed_at : (finite(source.observedAt) ? source.observedAt : null),
        receivedAt: finite(source.received_at) ? source.received_at : (finite(source.receivedAt) ? source.receivedAt : null),
        value: finite(source.value) ? source.value : (finite(source.usedPercent) ? source.usedPercent : null),
        status: source.status || 'unknown'
    };
}

function historyGroups(rows) {
    const groups = new Map();
    (Array.isArray(rows) ? rows : []).map(historyRow).forEach((row) => {
        const key = [row.provider, row.accountRef, row.poolId, row.windowId, stableValue(row.scope), row.segment].join('\u001f');
        if (!groups.has(key)) groups.set(key, { key, ...row, rows: [] });
        groups.get(key).rows.push(row);
    });
    return Array.from(groups.values()).map((group) => ({
        ...group,
        rows: group.rows.slice().sort((left, right) => (
            (left.observedAt || left.receivedAt || 0) - (right.observedAt || right.receivedAt || 0)
        ))
    }));
}

function worstUsageRow(snapshot, now) {
    const rows = usageRows(snapshot, now);
    return rows.slice().sort((left, right) => {
        const leftValue = finite(left.usedPercent) ? left.usedPercent : -1;
        const rightValue = finite(right.usedPercent) ? right.usedPercent : -1;
        if (rightValue !== leftValue) return rightValue - leftValue;
        if (left.fresh !== right.fresh) return left.fresh ? 1 : -1;
        return String(left.label || left.windowId || '').localeCompare(String(right.label || right.windowId || ''));
    })[0] || null;
}

module.exports = {
    finite,
    windowFresh,
    accountFresh,
    usageRows,
    codexUsageRows,
    displayFreshness,
    usageStatusText,
    statusBarLevel,
    scopeText,
    historyScope,
    historyRow,
    historyGroups,
    worstUsageRow
};
