import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDeployConfig, companionDeployDir, deployCompanion } from './companionDeploy.ts';

function tempDir(tag: string): string {
    const dir = path.join(os.tmpdir(), `pkm-harness-companion-deploy-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// ── parseDeployConfig ──────────────────────────────────────────────────────────────────

test('parseDeployConfig: obiekt z vault i configDir -> config po trim()', t => {
    t.deepEqual(parseDeployConfig({ vault: '  /Users/kuba/Vault  ', configDir: ' .obsidian ' }), {
        vault: '/Users/kuba/Vault',
        configDir: '.obsidian',
    });
});

test('parseDeployConfig: brak vault -> null', t => {
    t.is(parseDeployConfig({ configDir: '.obsidian' }), null);
});

test('parseDeployConfig: brak configDir -> null', t => {
    t.is(parseDeployConfig({ vault: '/Users/kuba/Vault' }), null);
});

test('parseDeployConfig: puste stringi po trim() -> null', t => {
    t.is(parseDeployConfig({ vault: '   ', configDir: '.obsidian' }), null);
});

test('parseDeployConfig: nie-obiekt (null/string/liczba/tablica) -> null', t => {
    t.is(parseDeployConfig(null), null);
    t.is(parseDeployConfig('nope'), null);
    t.is(parseDeployConfig(42), null);
    t.is(parseDeployConfig(['vault', 'configDir']), null);
});

// ── companionDeployDir ─────────────────────────────────────────────────────────────────

test('companionDeployDir: sklejka <vault>/<configDir>/plugins/pkm-assistant-dev', t => {
    const dir = companionDeployDir({ vault: '/Vault', configDir: '.obsidian' });
    t.is(dir, path.join('/Vault', '.obsidian', 'plugins', 'pkm-assistant-dev'));
});

// ── deployCompanion ────────────────────────────────────────────────────────────────────

test('deployCompanion: brak pliku config -> deployed:false, reason:no-config, zero zapisu', t => {
    const dist = tempDir('dist-no-config');
    fs.writeFileSync(path.join(dist, 'main.js'), 'console.log(1);');
    fs.writeFileSync(path.join(dist, 'manifest.json'), '{}');
    const missingConfig = path.join(dist, 'nie-istnieje.json');
    const distBefore = fs.readdirSync(dist).sort();
    // K6: nazwa testu obiecywała "zero zapisu", ale nic tego nie sprawdzało - katalog docelowy,
    // jaki powstałby GDYBY config istniał (ta sama funkcja co w teście "config poprawny" niżej,
    // inny tymczasowy vault) MA pozostać nieutworzony, skoro deployCompanion nigdy nie doszedł
    // do jego wyliczenia (zwraca się wcześniej, na braku pliku config).
    const wouldBeVault = tempDir('vault-no-config');
    const wouldBeTarget = companionDeployDir({ vault: wouldBeVault, configDir: '.obsidian' });

    const result = deployCompanion(dist, missingConfig);

    t.deepEqual(result, { deployed: false, reason: 'no-config' });
    t.deepEqual(fs.readdirSync(dist).sort(), distBefore, 'brak configu -> zero nowych plików w katalogu źródłowym (dist)');
    t.false(fs.existsSync(wouldBeTarget), 'katalog docelowy (plugins/pkm-assistant-dev) nie ma prawa powstać bez configu');
});

test('deployCompanion: config z bad JSON -> deployed:false, reason zawiera bad-json', t => {
    const dist = tempDir('dist-bad-json');
    const configPath = path.join(dist, 'deploy.local.json');
    fs.writeFileSync(configPath, '{not valid json');

    const result = deployCompanion(dist, configPath);

    t.false(result.deployed);
    t.true((result.reason ?? '').startsWith('bad-json'));
});

test('deployCompanion: config z brakującym polem -> deployed:false, reason bad-shape', t => {
    const dist = tempDir('dist-bad-shape');
    const configPath = path.join(dist, 'deploy.local.json');
    fs.writeFileSync(configPath, JSON.stringify({ vault: '/only-vault' }));

    const result = deployCompanion(dist, configPath);

    t.false(result.deployed);
    t.true((result.reason ?? '').startsWith('bad-shape'));
});

test('deployCompanion: config poprawny -> kopiuje main.js + manifest.json do <vault>/<configDir>/plugins/pkm-assistant-dev', t => {
    const dist = tempDir('dist-ok');
    fs.writeFileSync(path.join(dist, 'main.js'), 'console.log("companion");');
    fs.writeFileSync(path.join(dist, 'manifest.json'), '{"id":"pkm-assistant-dev"}');

    const vault = tempDir('vault-ok');
    const configPath = path.join(dist, 'deploy.local.json');
    fs.writeFileSync(configPath, JSON.stringify({ vault, configDir: '.obsidian' }));

    const result = deployCompanion(dist, configPath);

    const expectedTarget = path.join(vault, '.obsidian', 'plugins', 'pkm-assistant-dev');
    t.deepEqual(result, { deployed: true, target: expectedTarget });
    t.is(fs.readFileSync(path.join(expectedTarget, 'main.js'), 'utf8'), 'console.log("companion");');
    t.is(fs.readFileSync(path.join(expectedTarget, 'manifest.json'), 'utf8'), '{"id":"pkm-assistant-dev"}');
});
