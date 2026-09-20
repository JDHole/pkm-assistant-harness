// Obsidian evaluates one main.js with Electron require; relative modules must be bundled.
const path = require('node:path');
const esbuild = require('esbuild');
esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'ui/main.js')],
    outfile: path.join(__dirname, 'build/main.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2020',
    external: ['obsidian'],
    sourcemap: false,
    minify: false
});
