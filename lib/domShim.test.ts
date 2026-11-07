/** Wspólną atrapę ładuje również CJS/VM konsument pluginu. Nie wolno uzależnić
 * desktopowego portu fs od import.meta.url (esbuild usuwa je w formacie CJS).
 */
import test from 'ava';
import esbuild from 'esbuild';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

test('desktopowy port fs działa w bundlu CommonJS atrapy', async t => {
  const bundle = await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../test-support/dom-shim.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'cjs', write: false,
  });
  const sandbox = { module: { exports: {} }, nodeRequire: createRequire(import.meta.url) };
  const context = vm.createContext(sandbox);
  vm.runInContext(`(function(require, module, exports) { ${bundle.outputFiles[0].text} })(nodeRequire, module, module.exports)`, context);
  const hostFs = vm.runInContext("window.require('fs')", context);
  t.is(hostFs, fs, 'To prawdziwe fs, z atomowymi linkSync i fsyncSync');
  const first = vm.runInContext('window.require', context);
  vm.runInContext('module.exports.installDomShim()', context);
  t.is(vm.runInContext('window.require', context), first, 'Powtórne install nie podmienia portu');
  t.throws(() => vm.runInContext("window.require('unsupported-host-capability')", context), { message: /unsupported module/ });
});
