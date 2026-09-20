'use strict';

const { Plugin, Menu, Modal, Notice, requestUrl } = require('obsidian');
const CORE = require('./monitor_core.js');

const OLD = 'http://127.0.0.1:1234';
const STATUS = `${OLD}/most/status`;
const ECO = `${OLD}/most/eco`;
const RESTART = `${OLD}/most/restart`;
const API = 'http://127.0.0.1:1236/most/v1/';
const HEAD = { 'X-Most-Client': 'local-v1' };
const INTERVAL = 30000;
const WARN = 80;

const finite = CORE.finite;

function percent(value) {
    return finite(value) ? `${Math.round(value)}%` : null;
}

function statusLabel(status) {
    return ({
        fresh: 'świeże',
        stale: 'nieświeże',
        error: 'błąd',
        auth_required: 'wymaga logowania',
        unknown: 'nieznane',
        unsupported: 'nieobsługiwane'
    })[status] || 'nieznane';
}

function duration(minutes) {
    if (!finite(minutes) || minutes <= 0) return 'czas nieznany';
    if (minutes % 1440 === 0) return `${minutes / 1440} dni`;
    const rounded = Math.round(minutes);
    const hours = Math.floor(rounded / 60);
    const rest = rounded % 60;
    return hours ? `${hours} h${rest ? ` ${rest} min` : ''}` : `${rest} min`;
}

function dateTime(epoch) {
    if (!finite(epoch) || epoch <= 0) return 'nieznany termin';
    return new Date(epoch * 1000).toLocaleString('pl-PL', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
}

function resetText(epoch) {
    return finite(epoch) && epoch > 0 ? `reset ${dateTime(epoch)}` : 'reset nieznany';
}

function ageText(epoch, now) {
    if (!finite(epoch) || epoch <= 0 || !finite(now)) return 'wiek odczytu nieznany';
    const seconds = Math.max(0, Math.floor(now - epoch));
    if (seconds < 60) return 'wiek odczytu: przed chwilą';
    if (seconds < 3600) return `wiek odczytu: ${Math.floor(seconds / 60)} min`;
    if (seconds < 86400) return `wiek odczytu: ${Math.floor(seconds / 3600)} h`;
    return `wiek odczytu: ${Math.floor(seconds / 86400)} dni`;
}

function levelOf(status) {
    if (!status) return 'off';
    if (status.state === 'down') return 'down';
    if (status.state === 'starting' || status.state === 'suspect') return 'warn';
    const usage = status.usage || {};
    return (finite(usage.short_used_percent) && usage.short_used_percent >= WARN)
        || (finite(usage.weekly_used_percent) && usage.weekly_used_percent >= WARN)
        ? 'warn'
        : 'ok';
}

function shortText(status) {
    if (!status) return 'most: brak';
    const usage = status.usage || {};
    const parts = [];
    if (percent(usage.short_used_percent)) {
        parts.push(`krótkie${finite(usage.short_window_minutes) && usage.short_window_minutes > 0 ? ` ${duration(usage.short_window_minutes)}` : ''} ${percent(usage.short_used_percent)}`);
    }
    if (percent(usage.weekly_used_percent)) parts.push(`tydz ${percent(usage.weekly_used_percent)}`);
    return `${parts.length ? parts.join(' / ') : (status.state === 'ok' ? 'most ok' : `most ${status.state}`)}${usage.eco_mode ? ' ECO' : ''}`;
}

function longText(status, error) {
    if (!status) return `Most nie odpowiada na ${OLD}${error ? ` (${error})` : ''}`;
    const usage = status.usage || {};
    return [
        `Most: ${status.state}`,
        percent(usage.short_used_percent) && `Krótkie${finite(usage.short_window_minutes) && usage.short_window_minutes > 0 ? `: ${duration(usage.short_window_minutes)}` : ''}: ${percent(usage.short_used_percent)}`,
        percent(usage.weekly_used_percent) && `Tydzień: ${percent(usage.weekly_used_percent)}`,
        'Klik = menu'
    ].filter(Boolean).join('\n');
}

function freshnessText(account, row, now) {
    if (account.status === 'error') return 'błąd odczytu - pokazuję zachowany ostatni zapis';
    if (!finite(account.validUntil)) return 'ważność odczytu nieznana';
    if (account.validUntil <= now) return 'odczyt wygasł';
    if (finite(row.resetsAt) && row.resetsAt <= now) return 'okno jest po resecie';
    return row.fresh ? 'świeże' : statusLabel(account.status);
}

function sameScope(left, right) {
    return CORE.scopeText(left) === CORE.scopeText(right);
}

function scopeLabel(scope) {
    if (scope && scope.model && scope.model.display_name) return `Model: ${scope.model.display_name}`;
    return CORE.scopeText(scope);
}

function usageStatusText(snapshot, now) {
    const rows = CORE.usageRows(snapshot, now);
    if (!rows.length) return null;
    const perProvider = new Map();
    rows.forEach((row) => {
        const current = perProvider.get(row.provider);
        if (!current || (finite(row.usedPercent) ? row.usedPercent : -1) > (finite(current.usedPercent) ? current.usedPercent : -1)) {
            perProvider.set(row.provider, row);
        }
    });
    const providers = Array.from(perProvider.values()).map((row) => `${row.provider || 'konto'} ${percent(row.usedPercent) || '?'}`);
    return providers.join(' / ');
}

function usageStatusTooltip(snapshot, error, now) {
    const lines = [];
    (snapshot && snapshot.accounts || []).forEach((account) => {
        lines.push(`${account.label || account.provider || 'konto'}: ${statusLabel(account.status)} · ${ageText(account.observedAt, now)}`);
    });
    const worst = CORE.worstUsageRow(snapshot, now);
    if (worst) lines.push(`Najwyższe użycie: ${worst.label || worst.windowId || 'okno'} · ${CORE.scopeText(worst.scope)} · ${resetText(worst.resetsAt)}`);
    if (error) lines.push(`Błąd monitora: ${error}`);
    return lines.join('\n');
}

function create(parent, tag, className, text) {
    const node = parent.createEl(tag, { cls: className || '' });
    if (text != null) node.setText(String(text));
    return node;
}

function addProgress(parent, value, label) {
    const progress = create(parent, 'div', 'most-usage-progress');
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', label);
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', '100');
    if (finite(value)) {
        progress.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, Math.round(value)))));
        const fill = create(progress, 'i', '');
        fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
    }
    return progress;
}

function renderWindow(card, account, row, now) {
    const window = create(card, 'div', 'most-usage-window');
    create(window, 'strong', '', row.label || row.windowId || 'okno');
    create(window, 'span', 'most-usage-value', percent(row.usedPercent) || 'brak odczytu');
    addProgress(window, row.usedPercent, `${row.label || row.windowId || 'okno'}: ${percent(row.usedPercent) || 'brak odczytu'}`);
    const model = row.scope && row.scope.model && row.scope.model.display_name;
    create(window, 'small', 'most-usage-scope', model ? `Model: ${model}` : CORE.scopeText(row.scope));
    create(window, 'small', 'most-usage-time', `${duration(row.windowMinutes)} · ${resetText(row.resetsAt)}`);
    create(window, 'small', row.fresh ? 'most-usage-fresh' : 'most-usage-stale', freshnessText(account, row, now));

    const daily = (account.daily || []).find((item) => item
        && item.poolId === row.poolId
        && item.windowId === row.windowId
        && sameScope(item.scope, row.scope));
    if (daily) {
        const warning = finite(daily.deltaPp) && daily.deltaPp >= 30;
        const message = `${daily.date || 'nieznana data'}: +${finite(daily.deltaPp) ? Math.round(daily.deltaPp) : '?'} p.p. od startu pomiarów${daily.hasGap ? ' · luka danych' : ''}`;
        create(window, 'small', warning ? 'most-usage-daily is-warning' : 'most-usage-daily', message);
    }
}

function renderHistory(parent, rows, snapshot) {
    const section = create(parent, 'details', 'most-usage-section most-usage-history');
    create(section, 'summary', '', 'Historia pomiarów');
    const groups = CORE.historyGroups(rows);
    if (!groups.length) {
        create(section, 'p', 'most-usage-empty', 'Brak historii w monitorze.');
        return;
    }
    groups.forEach((group) => {
        const chartCard = create(section, 'section', 'most-usage-history-group');
        const account = (snapshot.accounts || []).find(a => a.accountRef === group.accountRef && a.provider === group.provider);
        const window = account && (account.windows || []).find(w => w.windowId === group.windowId && w.poolId === group.poolId);
        create(chartCard, 'h4', '', `${account ? account.label : group.provider || 'konto'} · ${window ? window.label : 'poprzednie okno'}`);
        create(chartCard, 'p', 'most-usage-scope', CORE.scopeText(group.scope));
        const chart = create(chartCard, 'div', 'most-usage-chart');
        const values = group.rows.filter((row) => finite(row.value)).slice(-16).map((row) => row.value);
        if (!values.length) create(chartCard, 'p', 'most-usage-empty', 'Brak liczbowych próbek tej puli.');
        values.forEach((value) => {
            const bar = create(chart, 'i', '');
            bar.style.height = `${Math.max(3, Math.min(100, value))}%`;
            bar.setAttribute('title', percent(value));
        });
        const table = create(chartCard, 'table', 'most-usage-history-table');
        group.rows.slice(-8).reverse().forEach((row) => {
            const tr = create(table, 'tr', '');
            create(tr, 'td', '', dateTime(row.observedAt || row.receivedAt));
            create(tr, 'td', '', percent(row.value) || 'brak');
            create(tr, 'td', '', statusLabel(row.status));
        });
    });
}

class UsageModal extends Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.unsubscribe = null;
    }

    onOpen() {
        this.modalEl.addClass('most-usage-dialog');
        this.contentEl.empty();
        this.contentEl.addClass('most-usage-modal');
        const header = create(this.contentEl, 'div', 'most-usage-modal-head');
        create(header, 'h2', '', 'Użycie subskrypcji');
        const refresh = create(header, 'button', 'mod-cta', 'Odśwież teraz');
        refresh.setAttribute('type', 'button');
        refresh.addEventListener('click', () => void this.plugin.refreshUsage(true));
        this.unsubscribe = this.plugin.subscribeUsage((snapshot, error) => this.render(snapshot, error));
        this.render(this.plugin.usageSnapshot, this.plugin.usageError);
        void this.plugin.fetchUsage(true);
    }

    onClose() {
        if (this.unsubscribe) this.unsubscribe();
        this.unsubscribe = null;
        this.contentEl.empty();
    }

    render(snapshot, error) {
        let body = this.contentEl.querySelector('.most-usage-body');
        if (!body) body = create(this.contentEl, 'div', 'most-usage-body');
        const scrollTop = this.contentEl.scrollTop;
        const historyOpen = body.querySelector('.most-usage-history')?.open || false;
        body.empty();
        if (error) create(body, 'p', 'most-usage-error', `Monitor: ${error}`);
        if (!snapshot) {
            create(body, 'p', 'most-usage-empty', 'Czekam na lokalny monitor użycia.');
            return;
        }
        const now = Date.now() / 1000;
        const meta = create(body, 'p', 'most-usage-meta', `Odczyt monitora: ${dateTime(snapshot.receivedAt)}`);
        meta.setAttribute('title', `Snapshot: ${snapshot.snapshotId || 'brak'}`);
        create(body, 'p', 'most-usage-meta', 'Ostrzeżenie dnia: +30 p.p. w tygodniowej puli.');
        if (snapshot.notificationStatus === 'error') {
            create(body, 'p', 'most-usage-error', snapshot.notificationReason === 'blocked:DisabledForUser'
                ? 'Windows ma wyłączone powiadomienia. Ostrzeżenia są widoczne tutaj.'
                : 'Ostatnie powiadomienie Windows nie zostało wysłane. Ostrzeżenia pozostają w panelu.');
        }
        const accounts = create(body, 'div', 'most-usage-accounts');
        (Array.isArray(snapshot.accounts) ? snapshot.accounts : []).forEach((account) => {
            const card = create(accounts, 'section', `most-usage-account most-usage-${account.status || 'unknown'}`);
            create(card, 'h3', '', account.label || account.provider || 'konto');
            if (Array.isArray(account.coverage)) create(card, 'p', 'most-usage-scope', account.coverage.join(' · '));
            const rows = CORE.usageRows({ accounts: [account] }, now);
            const visibleStatus = rows.some((row) => row.fresh)
                ? 'świeże'
                : (account.status === 'fresh' ? 'nieświeże' : statusLabel(account.status));
            create(card, 'p', 'most-usage-status', `${visibleStatus}${account.reason ? `: ${account.reason}` : ''}`);
            if (account.status === 'error') create(card, 'p', 'most-usage-error', 'Błąd odczytu - zachowany snapshot nie jest bieżącym stanem.');
            create(card, 'p', 'most-usage-observed', `${ageText(account.observedAt, now)} · obserwacja ${dateTime(account.observedAt)}`);
            if (!rows.length) create(card, 'p', 'most-usage-empty', 'Brak okien użycia w tym odczycie.');
            rows.forEach((row) => renderWindow(card, account, row, now));
        });
        const alerts = create(body, 'section', 'most-usage-section');
        create(alerts, 'h3', '', 'Ostatnie alerty');
        const items = Array.isArray(snapshot.alerts) ? snapshot.alerts : [];
        if (!items.length) create(alerts, 'p', 'most-usage-empty', 'Brak alertów.');
        items.slice(0, 8).forEach((alert) => create(alerts, 'p', 'most-usage-alert', alert.message || alert.kind || 'alert'));
        renderHistory(body, this.plugin.usageHistory, snapshot);
        const history = body.querySelector('.most-usage-history');
        if (history) history.open = historyOpen;
        this.contentEl.scrollTop = scrollTop;
    }
}

class MostStatusPlugin extends Plugin {
    async onload() {
        this.status = null;
        this.usageSnapshot = null;
        this.usageHistory = [];
        this.usageError = null;
        this.statusError = null;
        this.subscribers = new Set();
        this.inFlight = null;
        this.historyRequested = false;
        this.unloaded = false;

        this.item = this.addStatusBarItem();
        this.item.addClass('most-status');
        this.item.setAttribute('role', 'button');
        this.item.setAttribute('tabindex', '0');
        this.item.setAttribute('aria-label', 'Most: otwórz menu');
        this.dot = this.item.createSpan({ cls: 'most-status-dot' });
        this.text = this.item.createSpan({ cls: 'most-status-text', text: 'most...' });
        this.item.addEventListener('click', (event) => this.openMenu(event));
        this.item.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.openMenu(event);
            }
        });
        this.addCommand({ id: 'most-status-refresh', name: 'Odśwież stan mostu', callback: () => void this.refresh(true) });
        this.addCommand({ id: 'most-usage-open', name: 'Otwórz użycie subskrypcji Most', callback: () => this.openUsagePanel() });
        this.addRibbonIcon('gauge', 'Użycie subskrypcji Most', () => this.openUsagePanel());

        void this.refresh(false);
        void this.fetchUsage(false);
        this.pollId = window.setInterval(() => {
            void this.refresh(false);
            void this.fetchUsage(false);
        }, INTERVAL);
        this.registerInterval(this.pollId);
    }

    onunload() {
        this.unloaded = true;
        if (this.pollId) window.clearInterval(this.pollId);
        this.inFlight = null;
        this.historyRequested = false;
        this.subscribers.clear();
    }

    subscribeUsage(callback) {
        if (this.unloaded) return () => {};
        this.subscribers.add(callback);
        return () => this.subscribers.delete(callback);
    }

    notifyUsage() {
        if (this.unloaded) return;
        this.subscribers.forEach((callback) => {
            try {
                callback(this.usageSnapshot, this.usageError);
            } catch (_) {
                this.subscribers.delete(callback);
            }
        });
        this.renderStatus();
    }

    async fetchUsage(withHistory) {
        if (this.unloaded) return;
        this.historyRequested = this.historyRequested || Boolean(withHistory);
        if (this.inFlight) return this.inFlight;
        const request = (async () => {
            do {
                const loadHistory = this.historyRequested;
                this.historyRequested = false;
                try {
                    const usage = await requestUrl({ url: `${API}usage?maxAge=300`, method: 'GET', headers: HEAD, throw: false });
                    if (usage.status !== 200) throw Error(`HTTP ${usage.status}`);
                    if (this.unloaded) return;
                    this.usageSnapshot = usage.json;
                    this.usageError = null;
                    if (loadHistory || this.historyRequested) {
                        this.historyRequested = false;
                        const history = await requestUrl({ url: `${API}history?limit=200`, method: 'GET', headers: HEAD, throw: false });
                        if (history.status !== 200) throw Error(`HTTP ${history.status}`);
                        if (this.unloaded) return;
                        this.usageHistory = Array.isArray(history.json) ? history.json : (history.json.history || []);
                    }
                } catch (error) {
                    if (this.unloaded) return;
                    this.usageError = error && error.message ? error.message : String(error);
                }
                this.notifyUsage();
            } while (this.historyRequested && !this.unloaded);
        })();
        this.inFlight = request;
        try {
            await request;
        } finally {
            if (this.inFlight === request) this.inFlight = null;
        }
    }

    async refreshUsage(loud) {
        try {
            const response = await requestUrl({ url: `${API}refresh`, method: 'POST', headers: HEAD, throw: false });
            if (response.status >= 400) throw Error(`HTTP ${response.status}`);
            if (loud && !this.unloaded) new Notice('Monitor: odświeżanie zlecone');
        } catch (error) {
            if (loud && !this.unloaded) new Notice(`Monitor: błąd - ${error.message || error}`);
        }
        await this.fetchUsage(true);
    }

    openUsagePanel() {
        new UsageModal(this.app, this).open();
    }

    renderUsageTile(container, component) {
        const root = container.createEl('button', { cls: 'most-usage-tile' });
        root.setAttribute('type', 'button');
        root.setAttribute('aria-label', 'Otwórz szczegóły użycia subskrypcji');
        let wasConnected = false;
        let unsubscribe = null;
        const render = (snapshot, error) => {
            if (root.isConnected) wasConnected = true;
            if (wasConnected && !root.isConnected) {
                if (unsubscribe) unsubscribe();
                return;
            }
            root.empty();
            create(root, 'strong', '', snapshot ? usageStatusText(snapshot, Date.now() / 1000) || 'Użycie subskrypcji' : 'Użycie subskrypcji');
            if (error) create(root, 'span', 'most-usage-tile-error', `błąd: ${error}`);
            if (!snapshot) {
                create(root, 'span', 'most-usage-tile-state', 'czekam na monitor');
                return;
            }
            const now = Date.now() / 1000;
            const worst = CORE.worstUsageRow(snapshot, now);
            if (!worst) {
                create(root, 'span', 'most-usage-tile-state', 'brak okien użycia');
                return;
            }
            create(root, 'span', 'most-usage-tile-state', `${worst.accountLabel || worst.provider || 'konto'} · ${worst.label || worst.windowId || 'okno'}`);
            create(root, 'span', 'most-usage-tile-window', `${percent(worst.usedPercent) || 'brak odczytu'} · ${scopeLabel(worst.scope)}`);
            addProgress(root, worst.usedPercent, `${worst.label || worst.windowId || 'okno'}: ${percent(worst.usedPercent) || 'brak odczytu'}`);
            const tileFreshness = worst.accountStatus === 'error' ? 'błąd odczytu' : (worst.fresh ? 'świeże' : 'nieświeże');
            create(root, 'span', worst.fresh ? 'most-usage-tile-fresh' : 'most-usage-tile-stale', `${tileFreshness} · ${ageText(worst.observedAt, now)} · ${resetText(worst.resetsAt)}`);
            root.setAttribute('title', `${worst.label || worst.windowId || 'okno'}\n${CORE.scopeText(worst.scope)}\n${ageText(worst.observedAt, now)}\n${resetText(worst.resetsAt)}`);
        };
        unsubscribe = this.subscribeUsage(render);
        if (component && typeof component.register === 'function') component.register(unsubscribe);
        root.addEventListener('click', () => this.openUsagePanel());
        render(this.usageSnapshot, this.usageError);
        void this.fetchUsage(false);
        return unsubscribe;
    }

    async refresh(loud) {
        let error = null;
        try {
            const response = await requestUrl({ url: STATUS, method: 'GET', throw: false });
            if (response.status !== 200) throw Error(`HTTP ${response.status}`);
            if (this.unloaded) return;
            this.status = response.json;
        } catch (caught) {
            if (this.unloaded) return;
            this.status = null;
            error = caught.message || String(caught);
        }
        this.statusError = error;
        this.renderStatus();
        if (loud && !this.unloaded) new Notice(this.status ? `Most: ${shortText(this.status)}` : 'Most nie odpowiada');
    }

    renderStatus() {
        if (this.unloaded) return;
        const now = Date.now() / 1000;
        const usage = usageStatusText(this.usageSnapshot, now);
        const usageTooltip = usageStatusTooltip(this.usageSnapshot, this.usageError, now);
        this.dot.setAttribute('data-level', levelOf(this.status));
        this.text.setText(usage || shortText(this.status));
        this.text.toggleClass('is-eco', Boolean(this.status && this.status.usage && this.status.usage.eco_mode));
        this.item.setAttribute('title', [longText(this.status, this.statusError), usageTooltip].filter(Boolean).join('\n\n'));
    }

    openMenu(event) {
        const menu = new Menu();
        const eco = Boolean(this.status && this.status.usage && this.status.usage.eco_mode);
        menu.addItem((item) => item.setTitle('Użycie subskrypcji').setIcon('gauge').onClick(() => this.openUsagePanel()));
        menu.addItem((item) => item.setTitle('Odśwież stan').setIcon('refresh-cw').onClick(() => void this.refresh(true)));
        menu.addItem((item) => item
            .setTitle(`${eco ? '[x]' : '[ ]'} Tryb oszczędny (Astra -> Sol xhigh)`)
            .setIcon('leaf')
            .setDisabled(!this.status)
            .onClick(() => void this.post(ECO, { on: !eco }, eco ? 'Tryb oszczędny wyłączony' : 'Tryb oszczędny włączony')));
        menu.addItem((item) => item.setTitle('Restart mostu (ChatMock)').setIcon('rotate-ccw').onClick(() => void this.post(RESTART, {}, 'Restart ChatMocka zlecony')));
        menu.showAtMouseEvent(event);
    }

    async post(url, body, message) {
        try {
            const response = await requestUrl({
                url,
                method: 'POST',
                contentType: 'application/json',
                body: JSON.stringify(body),
                throw: false
            });
            if (response.status >= 400) throw Error(`HTTP ${response.status}`);
            if (!this.unloaded) new Notice(message);
        } catch (error) {
            if (!this.unloaded) new Notice(`Most: błąd - ${error.message || error}`);
        }
        await this.refresh(false);
    }
}

module.exports = MostStatusPlugin;
module.exports.__test = { levelOf, shortText, longText, duration, resetText, statusLabel, ageText, freshnessText };
