'use strict';
// Runs the plugin in Node against a real throwaway GitHub repo, with a mock obsidian module
// and temp folders as vaults. Each run works on its own branch, deleted at the end.
//   node test/run_sync_test.js owner/repo
// Token: GITHUB_TOKEN, else `gh auth token`. The repo needs a `seed` tag on a commit holding exactly
// README.md, notes/hello.md, notes/sub/deep.md, media/pixel.png, .obsidian/app.json, private/secret.md,
// so the test doesn't depend on whatever main holds now.

const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module');
const { execSync } = require('child_process');

const REPO = process.argv[2];
if (!REPO && process.env.NODE_TEST_CONTEXT) { console.log('# skipped: needs a repo, run it directly'); process.exit(0); } // under `node --test`
if (!REPO) { console.error('usage: node test/run_sync_test.js owner/repo'); process.exit(2); }
const TOKEN = process.env.GITHUB_TOKEN || execSync('gh auth token').toString().trim();
const BRANCH = `sync-test-${Date.now()}`;

/* ---------------- mock obsidian ---------------- */

let modalAnswer = false, modalShown = 0, beforePatch = null;
const hooks = {
  requestUrl: async ({ url, method = 'GET', headers, body }) => {
    if (method === 'PATCH' && beforePatch) { const f = beforePatch; beforePatch = null; await f(); }
    const res = await fetch(url, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body });
    const text = await res.text();
    return { status: res.status, get json() { return JSON.parse(text); } };
  },
};
class Notice { constructor(m) { this.m = m; } setMessage(m) { this.m = m; } hide() {} }
class Setting {
  constructor() { this.buttons = []; }
  addButton(cb) {
    const b = { setButtonText(t) { this.t = t; return this; }, setWarning() { return this; }, onClick(f) { this.f = f; return this; } };
    cb(b);
    Setting.last.push(b);
    return this;
  }
}
Setting.last = [];
class Modal {
  constructor() { this.titleEl = { setText() {} }; this.contentEl = { createEl() {} }; }
  open() { modalShown++; Setting.last.find(b => b.t === (modalAnswer ? 'Sync anyway' : 'Cancel')).f(); Setting.last = []; }
  close() { this.onClose(); }
}
class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; this.data = null; }
  async loadData() { return this.data; }
  async saveData(d) { this.data = JSON.parse(JSON.stringify(d)); }
  addSettingTab() {} addRibbonIcon() {} addCommand() {}
}
const obsidian = {
  Plugin, PluginSettingTab: class {}, Setting, Notice, Modal, Platform: {},
  requestUrl: p => hooks.requestUrl(p),
  arrayBufferToBase64: buf => Buffer.from(buf).toString('base64'),
  base64ToArrayBuffer: s => { const b = Buffer.from(s, 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
};
const load = Module._load;
Module._load = function (req, ...rest) { return req === 'obsidian' ? obsidian : load.call(this, req, ...rest); };
const SyncPlugin = require('../main.js');

function adapterFor(root) {
  const abs = p => path.join(root, p === '/' ? '' : p);
  return {
    root,
    exists: async p => fs.existsSync(abs(p)),
    mkdir: async p => fs.mkdirSync(abs(p), { recursive: true }),
    list: async p => {
      const dir = p === '/' ? '' : p, files = [], folders = [];
      for (const e of fs.readdirSync(abs(p), { withFileTypes: true })) (e.isDirectory() ? folders : files).push(dir ? `${dir}/${e.name}` : e.name);
      return { files, folders };
    },
    stat: async p => { const s = fs.statSync(abs(p)); return { mtime: s.mtimeMs, size: s.size, type: 'file' }; },
    readBinary: async p => { const b = fs.readFileSync(abs(p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
    writeBinary: async (p, buf) => fs.writeFileSync(abs(p), Buffer.from(buf)),
    trashLocal: async p => { fs.mkdirSync(path.join(root, '.trash'), { recursive: true }); fs.renameSync(abs(p), path.join(root, '.trash', path.basename(p))); },
  };
}

async function device(name, settings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sync-${name}-`));
  const app = { vault: { adapter: adapterFor(root), configDir: '.obsidian' } };
  const p = new SyncPlugin(app, { id: 'github-api-sync' });
  await p.onload();
  Object.assign(p.settings, { token: TOKEN, repo: REPO, branch: BRANCH, device: name }, settings);
  p.put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  p.get = rel => { const f = path.join(root, rel); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined; };
  p.rm = rel => fs.unlinkSync(path.join(root, rel));
  p.files = () => { const out = []; const walk = d => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const r = d ? `${d}/${e.name}` : e.name; e.isDirectory() ? walk(r) : out.push(r); } }; walk(''); return out.sort(); };
  return p;
}

/* ---------------- GitHub helpers ---------------- */

async function api(p, method = 'GET', body) {
  const res = await fetch(`https://api.github.com${p}`, { method, headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' }, body: body && JSON.stringify(body) });
  if (res.status >= 400) throw new Error(`${method} ${p}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
async function remoteFiles() {
  const b = await api(`/repos/${REPO}/branches/${BRANCH}`);
  const t = await api(`/repos/${REPO}/git/trees/${b.commit.commit.tree.sha}?recursive=1`);
  return t.tree.filter(e => e.type === 'blob').map(e => e.path).sort();
}
async function remoteText(p) {
  const c = await api(`/repos/${REPO}/contents/${p}?ref=${BRANCH}`);
  return Buffer.from(c.content, 'base64').toString('utf8');
}
async function laptopPut(p, text) { // a commit made elsewhere, like git on the laptop
  let sha;
  try { sha = (await api(`/repos/${REPO}/contents/${p}?ref=${BRANCH}`)).sha; } catch (e) { /* new file */ }
  await api(`/repos/${REPO}/contents/${p}`, 'PUT', { message: `laptop: ${p}`, content: Buffer.from(text).toString('base64'), branch: BRANCH, sha });
}
async function laptopDelete(p) {
  const { sha } = await api(`/repos/${REPO}/contents/${p}?ref=${BRANCH}`);
  await api(`/repos/${REPO}/contents/${p}`, 'DELETE', { message: `laptop: delete ${p}`, sha, branch: BRANCH });
}

/* ---------------- checks ---------------- */

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`);
  if (!ok) failures++;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const seed = await api(`/repos/${REPO}/git/ref/tags/seed`);
  await api(`/repos/${REPO}/git/refs`, 'POST', { ref: `refs/heads/${BRANCH}`, sha: seed.object.sha });
  console.log(`branch ${BRANCH}`);
  try {
    const A = await device('A');

    let r = await A.sync();
    check('first sync pulls the seed, skipping ignored files', eq(A.files(), ['README.md', 'media/pixel.png', 'notes/hello.md', 'notes/sub/deep.md']), `${r} ${A.files()}`);
    const png = fs.readFileSync(path.join(A.app.vault.adapter.root, 'media/pixel.png')).toString('base64');
    check('binary file is byte-exact', png === 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
    check('plugin data.json is saved', !!A.data.state.commit);

    A.put('notes/hello.md', '# Hello\n\nEdited on A.\n');
    A.put('notes/new.md', 'New on A.\n');
    A.rm('notes/sub/deep.md');
    A.put('private/mine.md', 'private\n');
    A.put('rec.m4a', 'audio');
    A.put('.obsidian/workspace.json', '{}');
    A.put('.obsidian/plugins/github-api-sync/data.json', '{"token":"x"}');
    r = await A.sync();
    check('push reports 3 changes', r === 'Synced: 3 changes pushed', r);
    const rf = await remoteFiles();
    check('remote has the edit, the addition and the delete', eq(rf, ['.obsidian/app.json', 'README.md', 'media/pixel.png', 'notes/hello.md', 'notes/new.md', 'private/secret.md']), rf);
    check('remote content matches', (await remoteText('notes/hello.md')) === '# Hello\n\nEdited on A.\n');
    check('second sync does nothing', (r = await A.sync()) === 'Already in sync', r);

    const B = await device('B');
    B.put('README.md', 'B had its own README\n');
    r = await B.sync();
    const copy = B.files().find(f => f.startsWith('README (conflict B '));
    check('first sync with a differing file keeps both', !!copy && B.get('README.md').startsWith('# Sync test') && B.get(copy) === 'B had its own README\n', `${r} ${B.files()}`);
    check('conflict copy is pushed', (await remoteFiles()).includes(copy));

    A.put('notes/hello.md', 'A second edit\n');
    B.put('notes/hello.md', 'B edit, longer\n');
    await A.sync();
    r = await B.sync();
    const copy2 = B.files().find(f => f.startsWith('notes/hello (conflict B '));
    check('edit on both sides: theirs keeps the path, ours becomes a copy', B.get('notes/hello.md') === 'A second edit\n' && copy2 && B.get(copy2) === 'B edit, longer\n', `${r} ${B.files()}`);
    r = await A.sync();
    check('A pulls both conflict copies', A.files().includes(copy) && A.files().includes(copy2), `${r} ${A.files()}`);

    await laptopPut('notes/new.md', 'Changed on the laptop.\n');
    A.put('README.md', 'A local README change\n');
    r = await A.sync({ push: false });
    check('pull only brings the laptop change and holds back the local one', A.get('notes/new.md') === 'Changed on the laptop.\n' && (await remoteText('README.md')).startsWith('# Sync test'), r);
    r = await A.sync();
    check('the held-back change pushes on the next full sync', r === 'Synced: 1 change pushed' && (await remoteText('README.md')) === 'A local README change\n', r);

    await laptopDelete('notes/new.md');
    r = await A.sync();
    check('remote delete moves the local file to .trash', !A.files().includes('notes/new.md') && A.files().includes('.trash/new.md'), `${r} ${A.files()}`);

    A.put('notes/race.md', 'from A\n');
    beforePatch = () => laptopPut('notes/laptop-race.md', 'pushed meanwhile\n');
    r = await A.sync();
    const rf2 = await remoteFiles();
    check('branch moved during push: retried and kept both', rf2.includes('notes/race.md') && rf2.includes('notes/laptop-race.md') && A.files().includes('notes/laptop-race.md'), `${r} ${rf2}`);

    for (let i = 0; i < 12; i++) A.put(`bulk/f${i}.md`, `file ${i}\n`);
    await A.sync();
    for (let i = 0; i < 12; i++) A.rm(`bulk/f${i}.md`);
    modalAnswer = false;
    const shown = modalShown;
    r = await A.sync();
    check('mass delete asks first, and cancelling changes nothing', modalShown === shown + 1 && r.startsWith('Sync cancelled') && (await remoteFiles()).includes('bulk/f0.md'), r);
    modalAnswer = true;
    r = await A.sync();
    check('mass delete goes ahead when confirmed', !(await remoteFiles()).some(f => f.startsWith('bulk/')), r);

    const C = await device('C', { vaultFolder: 'nb', repoFolder: 'notes' });
    r = await C.sync();
    check('folder mapping pulls notes/ into nb/', C.files().includes('nb/hello.md') && !C.files().some(f => !f.startsWith('nb/')), `${r} ${C.files()}`);
    C.put('nb/from-c.md', 'C\n');
    await C.sync();
    check('folder mapping pushes nb/ into notes/', (await remoteFiles()).includes('notes/from-c.md'));

    const D = await device('D', { vaultFolder: 'gone', repoFolder: 'notes' });
    await D.sync();
    fs.rmSync(path.join(D.app.vault.adapter.root, 'gone'), { recursive: true });
    r = await D.sync();
    check('missing vault folder after a sync refuses to run', r.includes('is missing'), r);

    await A.sync(); // catch up with C
    A.put('.gitignore', '*.tmp\nscratch/\n');
    A.put('note.tmp', 'tmp\n');
    r = await A.sync();
    let rf3 = await remoteFiles();
    check('a new .gitignore in the vault is pushed and applies in the same sync', rf3.includes('.gitignore') && !rf3.includes('note.tmp') && r === 'Synced: 1 change pushed. 1 local file skipped by .gitignore', `${r} ${rf3}`);
    A.put('scratch/x.md', 'scratch\n');
    await laptopPut('laptop.tmp', 'force-added on the laptop\n');
    r = await A.sync();
    rf3 = await remoteFiles();
    check('.gitignore holds back local files, counts them, and blocks pulls', r === 'Already in sync. 2 local files skipped by .gitignore' && !rf3.includes('note.tmp') && !rf3.includes('scratch/x.md') && !A.files().includes('laptop.tmp'), `${r} ${rf3} ${A.files()}`);
    A.settings.gitignore = false;
    r = await A.sync();
    rf3 = await remoteFiles();
    check('with the setting off they go out, and come in', r === 'Synced: 1 change pulled, 2 changes pushed' && rf3.includes('note.tmp') && rf3.includes('scratch/x.md') && A.get('laptop.tmp') === 'force-added on the laptop\n', `${r} ${rf3}`);
  } finally {
    await api(`/repos/${REPO}/git/refs/heads/${BRANCH}`, 'DELETE');
  }
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
