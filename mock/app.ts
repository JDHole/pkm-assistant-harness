/**
 * app.js — atrapa obiektu `app` Obsidiana, oparta o realny system plików temp-vaulta.
 *
 * NIE jest częścią aliasu 'obsidian' — to fabryka runtime'u budowana w run.js z realną
 * ścieżką temp-vaulta. Importuje `TFile`/`TFolder` z tej samej atrapy 'obsidian', więc
 * drzewo vaulta zwraca instancje TYCH klas (krytyczne dla `instanceof` w ToolLoader).
 *
 * Podział jak w Obsidianie:
 *   - `vault.adapter` (DataAdapter) — widzi WSZYSTKO na dysku, łącznie z dotfolderami
 *     (`.pkm-assistant`, `.obsidian`). Pamięć agentów tędy pisze.
 *   - `vault` (Vault API) — drzewo TFile/TFolder POMIJAJĄCE dotfoldery (jak Obsidian:
 *     Vault API nie indeksuje ukrytych ścieżek). Budowane leniwie z fs, cache + dirty.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { TFile, TFolder } from './obsidian.js';
import { createMockEl } from './dom-shim.js';
// Oba symbole wychodzą z barrela `core/index.js` (drzwi core) — atrapa nie ma powodu
// wchodzić do bebechów `core/utils/`. Barrel jest node-safe, więc wstaje w harnessie tak samo.
import { parseFrontmatter, stringifyYaml } from '../../core/index.js';

// TS-any: the harness app intentionally emulates the open-ended Obsidian App/Vault runtime surface.
type Runtime = any;

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Buduje atrapę `app` na temp-vaulcie.
 * @param {string} vaultRoot - absolutna ścieżka katalogu temp-vaulta
 */
export function createMockApp(vaultRoot: string): Runtime {
  const root = path.resolve(vaultRoot);

  const absOf = (rel: Runtime): string => {
    const clean = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\/+/, '');
    return clean ? path.join(root, clean) : root;
  };
  const relOf = (abs: string): string => path.relative(root, abs).replace(/\\/g, '/');
  const ensureParent = async (abs: string): Promise<void> => { await fsp.mkdir(path.dirname(abs), { recursive: true }); };

  let vault: Runtime; // forward ref dla markDirty
  const markDirty = () => { if (vault) vault._treeDirty = true; };

  // ── DataAdapter (fs) — kontrakt z LogFileSink + AgentMemory ──
  const adapter: Runtime = {
    getName() { return path.basename(root); },
    getBasePath() { return root; },

    async read(rel: Runtime) { return fsp.readFile(absOf(rel), 'utf8'); },

    async readBinary(rel: Runtime) { return toArrayBuffer(await fsp.readFile(absOf(rel))); },

    async write(rel: Runtime, data: Runtime) {
      const abs = absOf(rel);
      await ensureParent(abs);
      await fsp.writeFile(abs, data ?? '', 'utf8');
      markDirty();
    },

    async writeBinary(rel: Runtime, data: Runtime) {
      const abs = absOf(rel);
      await ensureParent(abs);
      await fsp.writeFile(abs, Buffer.from(data));
      markDirty();
    },

    async append(rel: Runtime, data: Runtime) {
      const abs = absOf(rel);
      await ensureParent(abs);
      await fsp.appendFile(abs, data ?? '', 'utf8');
      markDirty();
    },

    async exists(rel: Runtime) {
      try { await fsp.access(absOf(rel)); return true; } catch { return false; }
    },

    async stat(rel: Runtime) {
      try {
        const st = await fsp.stat(absOf(rel));
        return {
          type: st.isDirectory() ? 'folder' : 'file',
          ctime: st.ctimeMs,
          mtime: st.mtimeMs,
          size: st.size,
        };
      } catch { return null; }
    },

    async mkdir(rel: Runtime) { await fsp.mkdir(absOf(rel), { recursive: true }); markDirty(); },

    async list(rel: Runtime) {
      const abs = absOf(rel);
      const files: string[] = [];
      const folders: string[] = [];
      let entries;
      try { entries = await fsp.readdir(abs, { withFileTypes: true }); }
      catch { return { files, folders }; } // brak katalogu → puste (bardziej wybaczające niż Obsidian)
      for (const e of entries) {
        const childRel = relOf(path.join(abs, e.name));
        if (e.isDirectory()) folders.push(childRel);
        else files.push(childRel);
      }
      return { files, folders };
    },

    async remove(rel: Runtime) { await fsp.rm(absOf(rel), { force: true }); markDirty(); },
    async rmdir(rel: Runtime, recursive = false) { await fsp.rm(absOf(rel), { recursive, force: true }); markDirty(); },
    async trashSystem(rel: Runtime) { await fsp.rm(absOf(rel), { recursive: true, force: true }); markDirty(); return true; },
    async trashLocal(rel: Runtime) { await fsp.rm(absOf(rel), { recursive: true, force: true }); markDirty(); },
    async rename(from: Runtime, to: Runtime) { const abs = absOf(to); await ensureParent(abs); await fsp.rename(absOf(from), abs); markDirty(); },
    async copy(from: Runtime, to: Runtime) { const abs = absOf(to); await ensureParent(abs); await fsp.copyFile(absOf(from), abs); markDirty(); },

    getResourcePath(rel: Runtime) { return 'app://harness/' + rel; },
  };

  // ── Vault API (drzewo TFile/TFolder, pomija dotfoldery) ──
  const buildTree = (): void => {
    const rootFolder = new TFolder();
    rootFolder.path = '/';
    rootFolder.name = '';
    rootFolder.vault = vault;
    rootFolder.children = [];

    const map = new Map<string, Runtime>();
    map.set('/', rootFolder);
    map.set('', rootFolder);

    const walk = (absDir: string, relDir: string, parent: Runtime): void => {
      let entries;
      try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue; // Vault API nie widzi dotfolderów
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        const abs = path.join(absDir, e.name);
        if (e.isDirectory()) {
          const folder = new TFolder();
          folder.path = rel;
          folder.name = e.name;
          folder.parent = parent;
          folder.vault = vault;
          folder.children = [];
          parent.children.push(folder);
          map.set(rel, folder);
          walk(abs, rel, folder);
        } else if (e.isFile()) {
          const file = new TFile();
          file.path = rel;
          file.name = e.name;
          const dot = e.name.lastIndexOf('.');
          file.extension = dot >= 0 ? e.name.slice(dot + 1) : '';
          file.basename = dot >= 0 ? e.name.slice(0, dot) : e.name;
          file.parent = parent;
          file.vault = vault;
          try {
            const st = fs.statSync(abs);
            file.stat = { ctime: st.ctimeMs, mtime: st.mtimeMs, size: st.size };
          } catch { file.stat = { ctime: 0, mtime: 0, size: 0 }; }
          parent.children.push(file);
          map.set(rel, file);
        }
      }
    };
    walk(root, '', rootFolder);

    vault._treeMap = map;
    vault._treeRoot = rootFolder;
    vault._allFiles = [...map.values()].filter((n) => n instanceof TFile);
    vault._treeDirty = false;
  };

  const ensureTree = (): void => { if (vault._treeDirty || !vault._treeMap) buildTree(); };
  const normPath = (p: Runtime): string => {
    if (p == null) return '';
    let s = String(p).replace(/\\/g, '/');
    if (s !== '/' && s.length > 1) s = s.replace(/\/+$/, '');
    return s.replace(/^\/(?!$)/, '');
  };

  const eventHandle = (name: string, fn?: Runtime): Runtime => ({ name, fn, e: 'harness' });

  vault = <Runtime>{
    adapter,
    configDir: '.obsidian',
    _treeDirty: true,
    _treeMap: null,

    getName() { return path.basename(root); },

    getRoot() { ensureTree(); return vault._treeRoot; },

    getAbstractFileByPath(p: Runtime) { ensureTree(); return vault._treeMap.get(normPath(p)) || null; },
    getFileByPath(p: Runtime) { const f = vault.getAbstractFileByPath(p); return f instanceof TFile ? f : null; },
    getFolderByPath(p: Runtime) { const f = vault.getAbstractFileByPath(p); return f instanceof TFolder ? f : null; },

    getFiles() { ensureTree(); return vault._allFiles.slice(); },
    getAllLoadedFiles() { ensureTree(); return [...vault._treeMap.values()].filter((n) => n.path !== '' && n.path !== '/'); },
    getMarkdownFiles() { ensureTree(); return vault._allFiles.filter((f: Runtime) => f.extension === 'md'); },

    async read(file: Runtime) { return adapter.read(typeof file === 'string' ? file : file.path); },
    async cachedRead(file: Runtime) { return adapter.read(typeof file === 'string' ? file : file.path); },
    async readBinary(file: Runtime) { return adapter.readBinary(typeof file === 'string' ? file : file.path); },

    async create(p: Runtime, data: Runtime) { await adapter.write(p, data); return vault.getAbstractFileByPath(p) || makeDetachedFile(p); },
    async createBinary(p: Runtime, data: Runtime) { await adapter.writeBinary(p, data); return vault.getAbstractFileByPath(p) || makeDetachedFile(p); },
    async createFolder(p: Runtime) { await adapter.mkdir(p); return vault.getAbstractFileByPath(p) || makeDetachedFolder(p); },

    async modify(file: Runtime, data: Runtime) { await adapter.write(typeof file === 'string' ? file : file.path, data); },
    async modifyBinary(file: Runtime, data: Runtime) { await adapter.writeBinary(typeof file === 'string' ? file : file.path, data); },
    async append(file: Runtime, data: Runtime) { await adapter.append(typeof file === 'string' ? file : file.path, data); },

    async process(file: Runtime, fn: Runtime) {
      const p = typeof file === 'string' ? file : file.path;
      const content = await adapter.read(p);
      const next = fn(content);
      await adapter.write(p, next);
      return next;
    },

    async delete(file: Runtime, _force = false) {
      const p = typeof file === 'string' ? file : file.path;
      if (file instanceof TFolder) await adapter.rmdir(p, true);
      else await adapter.remove(p);
    },
    async trash(file: Runtime, _system = true) { return vault.delete(file); },
    async rename(file: Runtime, newPath: Runtime) { await adapter.rename(typeof file === 'string' ? file : file.path, newPath); },
    async copy(file: Runtime, newPath: Runtime) { await adapter.copy(typeof file === 'string' ? file : file.path, newPath); return vault.getAbstractFileByPath(newPath) || makeDetachedFile(newPath); },

    on(name: string, fn: Runtime) { return eventHandle(name, fn); },
    off() {},
    offref() {},
    trigger() {},
    getConfig() { return null; },
  };

  function makeDetachedFile(p: Runtime): Runtime {
    const f = new TFile();
    f.path = normPath(p);
    f.name = f.path.split('/').pop();
    const dot = f.name.lastIndexOf('.');
    f.extension = dot >= 0 ? f.name.slice(dot + 1) : '';
    f.basename = dot >= 0 ? f.name.slice(0, dot) : f.name;
    f.vault = vault;
    return f;
  }
  function makeDetachedFolder(p: Runtime): Runtime {
    const f = new TFolder();
    f.path = normPath(p);
    f.name = f.path.split('/').pop();
    f.vault = vault;
    return f;
  }

  // ── metadataCache (v1-lite) ──
  const readFrontmatterSync = (p: string): Runtime => {
    try {
      const content = fs.readFileSync(absOf(p), 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      return { frontmatter: frontmatter || {}, links: [], embeds: [], headings: [], tags: [], sections: [] };
    } catch { return null; }
  };

  const metadataCache: Runtime = {
    resolvedLinks: {},
    unresolvedLinks: {},
    getFileCache(file: Runtime) { return readFrontmatterSync(typeof file === 'string' ? file : file?.path); },
    getCache(p: string) { return readFrontmatterSync(p); },
    fileToLinktext(file: Runtime) { return (typeof file === 'string' ? file : file?.basename) || ''; },
    getFirstLinkpathDest(linkpath: Runtime) {
      if (!linkpath) return null;
      ensureTree();
      const want = String(linkpath).replace(/\.md$/, '');
      for (const f of vault._allFiles) {
        if (f.basename === want || f.path === linkpath || f.path === `${want}.md`) return f;
      }
      return null;
    },
    on() { return eventHandle('meta'); },
    off() {}, offref() {}, trigger() {},
  };

  // ── fileManager ──
  const fileManager: Runtime = {
    async processFrontMatter(file: Runtime, fn: Runtime) {
      const p = typeof file === 'string' ? file : file.path;
      let content = '';
      try { content = await adapter.read(p); } catch { content = ''; }
      const parsed = parseFrontmatter(content);
      const fm = parsed.frontmatter && typeof parsed.frontmatter === 'object' ? parsed.frontmatter : {};
      const body = parsed.content != null ? parsed.content : content;
      await fn(fm);
      const yamlText = stringifyYaml(fm).replace(/\n$/, '');
      const next = `---\n${yamlText}\n---\n${body}`;
      await adapter.write(p, next);
    },
    generateMarkdownLink(file: Runtime) { return `[[${(typeof file === 'string' ? file : file?.basename) || ''}]]`; },
    async renameFile(file: Runtime, newPath: Runtime) { await vault.rename(file, newPath); },
    getNewFileParent() { return vault.getRoot(); },
  };

  // ── workspace ──
  // `createMockLeaf()` — atrapa WorkspaceLeaf. `getLeaf()` zwracało `null`, co wywalało KAŻDEGO
  // z czterech wołaczy w repo (`ReleaseNotesView.open`, `PluginItemView.setViewState`, dwóch miejsc
  // z `.openFile()`) na `Cannot read properties of null` — leaf jest tu ATRAPĄ, nie brakiem
  // miejsca docelowego (ogony-ogA, fala 3, 2026-09-04). `setViewState`/`openFile` są no-opami
  // (harness nie renderuje realnego widoku), ale nie rzucają — dokładnie to, czego potrzebuje
  // bootstrap, żeby przejść przez `workspace.getLeaf(...).setViewState(...)` bez wybuchu.
  const createMockLeaf = (): Runtime => ({
    containerEl: createMockEl('div'),
    view: null,
    async setViewState() { return true; },
    async openFile() { return; },
    detach() {},
    setPinned() {},
  });
  const workspace: Runtime = {
    containerEl: createMockEl('div'),
    activeLeaf: null,
    onLayoutReady(cb: Runtime) { queueMicrotask(() => { try { cb(); } catch (e) { console.error('[harness] onLayoutReady cb error:', e); } }); },
    on(name: string, fn: Runtime) { return eventHandle(name, fn); },
    off() {}, offref() {}, trigger() {},
    getLeaf() { return createMockLeaf(); },
    getLeavesOfType() { return []; },
    getRightLeaf() { return null; },
    getLeftLeaf() { return null; },
    getMostRecentLeaf() { return null; },
    revealLeaf() {},
    getActiveViewOfType() { return null; },
    getActiveFile() { return null; },
    iterateAllLeaves() {},
    iterateRootLeaves() {},
    get rightSplit() { return { collapsed: false, toggle() {} }; },
    get leftSplit() { return { collapsed: false, toggle() {} }; },
  };

  // ── app ──
  const app: Runtime = {
    vault,
    metadataCache,
    fileManager,
    workspace,
    keymap: { pushScope() {}, popScope() {} },
    scope: { register() {}, unregister() {} },
    internalPlugins: { plugins: {}, getEnabledPluginById() { return null; } },
    plugins: { plugins: {}, getPlugin() { return null; }, enablePlugin() {}, disablePlugin() {} },
    lastEvent: null,
    loadLocalStorage() { return null; },
    saveLocalStorage() {},
  };

  return app;
}
