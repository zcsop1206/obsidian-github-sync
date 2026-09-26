'use strict';
/*
 * GitHub API sync. Syncs a vault folder with a folder in a GitHub repo through the
 * REST API, for devices that can't run git (the iPad). Laptops use plain git.
 *
 * Sync is three-way. The plugin remembers each file's git blob SHA at the last sync
 * (the base) and compares it with the vault and with the branch head:
 *   changed only here   -> pushed in one commit
 *   changed only there  -> pulled
 *   changed on both     -> theirs keeps the path, ours is kept as "name (conflict ...)"
 * A change beats a delete. Local deletes go to Obsidian's .trash; remote ones stay in git history.
 */

const {
  Plugin, PluginSettingTab, Setting, Notice, Modal, Platform, requestUrl,
  arrayBufferToBase64, base64ToArrayBuffer,
} = require('obsidian');

const DEFAULT_IGNORE = `# One rule per line, relative to the synced folder.
#   *.ext   that extension anywhere
#   name/   a folder with that name anywhere
#   other   that exact path, or that file name anywhere if it has no slash
.obsidian/
private/
*.m4a
*.webm
*.ogg
*.mp3
*.wav`;
const ALWAYS_IGNORE = ['.git/', '.trash/', '.DS_Store'];
const DEFAULTS = { token: '', repo: '', branch: 'main', vaultFolder: '', repoFolder: '', device: '', ignore: DEFAULT_IGNORE };
const PARALLEL = 4;
const MASS_DELETE = { count: 10, share: 0.25 }; // ask first when more deletes than both of these

const trimSlashes = s => s.trim().replace(/^\/+|\/+$/g, '');
const join = (a, b) => (a && b ? `${a}/${b}` : a || b);
const encPath = p => p.split('/').map(encodeURIComponent).join('/');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function parseRules(text) {
  return text.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
}

function matches(path, rules) {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return rules.some(r => r.startsWith('*.') ? name.endsWith(r.slice(1).toLowerCase())
    : r.endsWith('/') ? path.startsWith(r) || path.includes(`/${r}`)
    : r.includes('/') ? path === r
    : name === r.toLowerCase());
}

// git's blob SHA-1: sha1("blob <length>\0" + bytes)
async function blobSha(buf) {
  const bytes = new Uint8Array(buf), head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head);
  all.set(bytes, head.length);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-1', all));
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
}

async function pool(items, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
}

// One GitHub REST call. Returns parsed JSON or throws an Error with GitHub's message and status.
async function gh(token, path, method = 'GET', body) {
  const res = await requestUrl({
    url: `https://api.github.com${path}`,
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    contentType: body ? 'application/json' : undefined,
    body: body ? JSON.stringify(body) : undefined,
    throw: false,
  });
  let json = null;
  try { json = res.json; } catch (e) { /* not JSON */ }
  if (res.status >= 400) {
    const err = new Error(`${res.status}${json && json.message ? `: ${json.message}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

function confirmModal(app, text, yes) {
  return new Promise(resolve => {
    let ok = false;
    const m = new Modal(app);
    m.titleEl.setText('GitHub API sync');
    m.contentEl.createEl('p', { text });
    new Setting(m.contentEl)
      .addButton(b => b.setButtonText('Cancel').onClick(() => m.close()))
      .addButton(b => b.setButtonText(yes).setWarning().onClick(() => { ok = true; m.close(); }));
    m.onClose = () => resolve(ok);
    m.open();
  });
}

function defaultDevice() {
  if (Platform.isIosApp) return Platform.isTablet ? 'iPad' : 'iPhone';
  if (Platform.isAndroidApp) return 'Android';
  return 'desktop';
}

module.exports = class GitHubApiSync extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    // 0.0.1 stored the settings flat; later versions store { settings, state }.
    this.settings = Object.assign({}, DEFAULTS, data.settings || (data.state ? {} : data));
    if (!this.settings.device) this.settings.device = defaultDevice();
    this.state = data.state || {};
    this.busy = false;
    this.addSettingTab(new SyncSettingTab(this.app, this));
    this.addRibbonIcon('refresh-cw', 'Sync with GitHub', () => this.sync());
    this.addCommand({ id: 'sync', name: 'Sync now (pull and push)', callback: () => this.sync() });
    this.addCommand({ id: 'pull', name: 'Pull only', callback: () => this.sync({ push: false }) });
    this.addCommand({ id: 'check-connection', name: 'Check GitHub connection', callback: () => this.checkConnection() });
  }

  get adapter() { return this.app.vault.adapter; }
  get dataPath() { return `${this.app.vault.configDir}/plugins/${this.manifest.id}/data.json`; }

  async save() {
    await this.saveData({ settings: this.settings, state: this.state });
  }
  saveSettings() { return this.save(); }

  api(path, method, body) { return gh(this.settings.token, path, method, body); }

  configProblem() {
    const { token, repo, branch } = this.settings;
    if (!token) return 'No token set';
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return 'Repo must look like owner/name';
    if (!branch) return 'No branch set';
    return null;
  }

  // Reads the repo, the branch head and the repo folder. Returns a one-line report.
  async checkConnection() {
    const { repo, branch, repoFolder } = this.settings;
    let report = this.configProblem();
    if (!report) {
      try {
        const r = await this.api(`/repos/${repo}`);
        const b = await this.api(`/repos/${repo}/branches/${encodeURIComponent(branch)}`);
        let where = 'repo root';
        if (repoFolder) {
          const items = await this.api(`/repos/${repo}/contents/${encPath(repoFolder)}?ref=${encodeURIComponent(branch)}`);
          where = Array.isArray(items) ? `${repoFolder}/ (${items.length} entries)` : `${repoFolder} is a file, not a folder`;
        }
        report = `Connected to ${r.full_name} (${r.private ? 'private' : 'public'}), ${branch} at ${b.commit.sha.slice(0, 7)}, ${where}`;
      } catch (e) {
        report = this.explain(e);
      }
    }
    new Notice(report, 8000);
    return report;
  }

  explain(e) {
    if (e.status === 404) return `Not found (${e.message}): check the repo, branch, folder and the token's repo access`;
    if (e.status === 401) return 'Token rejected (401): it may be wrong or expired';
    if (e.status === 403) return `Forbidden (${e.message}): the token may lack Contents write access, or the rate limit was hit`;
    return e.status ? `GitHub error ${e.message}` : e.message;
  }

  ignored(rel) {
    const path = join(this.settings.vaultFolder, rel);
    return path === this.dataPath || matches(path, ALWAYS_IGNORE) || matches(rel, this.rules);
  }

  // Pull, then push unless push is false. Retries if the branch moves while pushing.
  async sync({ push = true } = {}) {
    if (this.busy) { new Notice('Sync is already running'); return 'busy'; }
    const problem = this.configProblem();
    if (problem) { new Notice(problem); return problem; }
    this.busy = true;
    const note = new Notice('Sync: starting', 0);
    let report;
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          report = await this.syncOnce(push, m => note.setMessage(`Sync: ${m}`));
          break;
        } catch (e) {
          if (!e.moved || attempt >= 3) throw e;
        }
      }
    } catch (e) {
      console.error('[github-api-sync]', e);
      report = `Sync failed: ${this.explain(e)}`;
    } finally {
      this.busy = false;
      note.hide();
    }
    new Notice(report, 8000);
    return report;
  }

  async syncOnce(push, progress) {
    const s = this.settings, a = this.adapter;
    this.rules = parseRules(s.ignore);
    const key = `${s.repo}@${s.branch}:${s.repoFolder}>${s.vaultFolder}`;
    if (this.state.key !== key) this.state = { key, commit: null, base: {}, local: {} };
    const base = this.state.base;

    progress('reading GitHub');
    const br = await this.api(`/repos/${s.repo}/branches/${encodeURIComponent(s.branch)}`);
    const head = br.commit.sha, headTree = br.commit.commit.tree.sha;
    const tree = await this.api(`/repos/${s.repo}/git/trees/${headTree}?recursive=1`);
    if (tree.truncated) throw new Error('The repo tree is too large to read in one request');
    const prefix = s.repoFolder ? `${s.repoFolder}/` : '';
    const remote = {}, modes = {}, known = new Set();
    for (const e of tree.tree) {
      if (e.type !== 'blob') continue;
      known.add(e.sha);
      if (!e.path.startsWith(prefix) || e.mode === '120000') continue;
      const rel = e.path.slice(prefix.length);
      if (this.ignored(rel)) continue;
      remote[rel] = e.sha;
      modes[rel] = e.mode;
    }

    progress('reading the vault');
    const cache = {};
    const local = await this.scanLocal(cache, Object.keys(base).length > 0);

    // Plan. Every path is on at most one list.
    const down = [], trash = [], up = [], del = [], both = [], next = {};
    for (const rel of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
      const b = base[rel], l = local[rel], r = remote[rel];
      if (l === r) { if (r) next[rel] = r; }
      else if (l === b) (r ? down : trash).push(rel);  // changed only there
      else if (r === b) (l ? up : del).push(rel);      // changed only here
      else if (!l) down.push(rel);                     // deleted here, changed there: keep theirs
      else if (!r) up.push(rel);                       // changed here, deleted there: keep ours
      else both.push(rel);                             // changed on both sides: keep both
    }
    if (!push) for (const rel of [...up, ...del]) if (base[rel]) next[rel] = base[rel];

    const deletes = trash.length + (push ? del.length : 0), known0 = Object.keys(base).length;
    if (deletes > MASS_DELETE.count && deletes > known0 * MASS_DELETE.share) {
      const ok = await confirmModal(this.app,
        `This sync would delete ${plural(trash.length, 'file')} in the vault (to .trash)` +
        (push ? ` and ${plural(del.length, 'file')} in ${s.repo}` : '') + `, out of ${known0} synced. Continue?`,
        'Sync anyway');
      if (!ok) return 'Sync cancelled, nothing changed';
    }

    const vpath = rel => join(s.vaultFolder, rel);
    const fetchBlob = async sha => base64ToArrayBuffer((await this.api(`/repos/${s.repo}/git/blobs/${sha}`)).content.replace(/\s/g, ''));
    const write = async (rel, buf, sha) => {
      const p = vpath(rel), dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      if (dir) await this.ensureDir(dir);
      await a.writeBinary(p, buf);
      const st = await a.stat(p);
      cache[rel] = { mtime: st.mtime, size: st.size, sha };
    };

    // Conflicts: our version moves to a copy (pushed below), theirs takes the path.
    const taken = new Set([...Object.keys(local), ...Object.keys(remote)]);
    for (const rel of both) {
      const copy = this.conflictName(rel, taken);
      await write(copy, await a.readBinary(vpath(rel)), local[rel]);
      local[copy] = local[rel];
      up.push(copy);
      down.push(rel);
    }

    let done = 0;
    await pool(down, async rel => {
      progress(`pulling ${++done}/${down.length}`);
      await write(rel, await fetchBlob(remote[rel]), remote[rel]);
      next[rel] = remote[rel];
    });
    for (const rel of trash) {
      if (await a.exists(vpath(rel))) await a.trashLocal(vpath(rel));
      delete cache[rel];
    }

    let commit = head;
    if (push && (up.length || del.length)) {
      const entries = [];
      done = 0;
      await pool(up, async rel => {
        progress(`pushing ${++done}/${up.length}`);
        const sha = local[rel];
        if (!known.has(sha)) {
          const made = await this.api(`/repos/${s.repo}/git/blobs`, 'POST', { content: arrayBufferToBase64(await a.readBinary(vpath(rel))), encoding: 'base64' });
          if (made.sha !== sha) throw new Error(`${rel} changed while syncing, try again`);
        }
        entries.push({ path: prefix + rel, mode: modes[rel] || '100644', type: 'blob', sha });
      });
      for (const rel of del) entries.push({ path: prefix + rel, mode: modes[rel] || '100644', type: 'blob', sha: null });
      progress('committing');
      const t = await this.api(`/repos/${s.repo}/git/trees`, 'POST', { base_tree: headTree, tree: entries });
      const c = await this.api(`/repos/${s.repo}/git/commits`, 'POST', { message: this.message(up, del), tree: t.sha, parents: [head] });
      try {
        await this.api(`/repos/${s.repo}/git/refs/heads/${encPath(s.branch)}`, 'PATCH', { sha: c.sha, force: false });
      } catch (e) {
        if (e.status === 422 || e.status === 409) e.moved = true; // someone pushed meanwhile: start over
        throw e;
      }
      commit = c.sha;
      for (const rel of up) next[rel] = local[rel];
    }

    this.state = { key, commit, base: next, local: cache };
    await this.save();

    const pulled = down.length - both.length + trash.length, pushed = push ? up.length + del.length : 0;
    const parts = [];
    if (pulled) parts.push(`${plural(pulled, 'change')} pulled`);
    if (pushed) parts.push(`${plural(pushed, 'change')} pushed`);
    if (!push && (up.length || del.length)) parts.push(`${plural(up.length + del.length, 'local change')} not pushed`);
    if (both.length) parts.push(`${plural(both.length, 'conflict')} kept as "(conflict ${s.device} ...)" copies`);
    return parts.length ? `Synced: ${parts.join(', ')}` : 'Already in sync';
  }

  // rel -> blob SHA for every synced file in the vault folder. Rehashes only files whose mtime or size changed.
  async scanLocal(cache, hadBase) {
    const a = this.adapter, root = this.settings.vaultFolder, old = this.state.local || {}, out = {};
    if (root && !(await a.exists(root))) {
      if (hadBase) throw new Error(`Vault folder "${root}" is missing; not syncing so nothing gets deleted`);
      await this.ensureDir(root);
      return out;
    }
    const relOf = p => { p = p.replace(/^\/+/, ''); return root ? p.slice(root.length + 1) : p; };
    const walk = async dir => {
      const { files, folders } = await a.list(dir || '/');
      for (const f of files) {
        const rel = relOf(f);
        if (!rel || this.ignored(rel)) continue;
        const st = await a.stat(f), c = old[rel];
        const sha = c && c.mtime === st.mtime && c.size === st.size ? c.sha : await blobSha(await a.readBinary(f));
        cache[rel] = { mtime: st.mtime, size: st.size, sha };
        out[rel] = sha;
      }
      for (const d of folders) if (!this.ignored(`${relOf(d)}/`)) await walk(d.replace(/^\/+/, ''));
    };
    await walk(root);
    return out;
  }

  async ensureDir(path) {
    let acc = '';
    for (const part of path.split('/')) {
      acc = join(acc, part);
      if (!(await this.adapter.exists(acc))) await this.adapter.mkdir(acc);
    }
  }

  conflictName(rel, taken) {
    const slash = rel.lastIndexOf('/'), dot = rel.lastIndexOf('.');
    const [stem, ext] = dot > slash + 1 ? [rel.slice(0, dot), rel.slice(dot)] : [rel, ''];
    const tag = `conflict ${this.settings.device} ${new Date().toISOString().slice(0, 10)}`;
    let name = `${stem} (${tag})${ext}`;
    for (let i = 2; taken.has(name); i++) name = `${stem} (${tag} ${i})${ext}`;
    taken.add(name);
    return name;
  }

  message(up, del) {
    const lines = [...up.map(r => `+ ${r}`), ...del.map(r => `- ${r}`)];
    const shown = lines.slice(0, 20).join('\n') + (lines.length > 20 ? `\n… and ${lines.length - 20} more` : '');
    return `Sync from ${this.settings.device}: ${plural(up.length, 'file')} changed, ${del.length} deleted\n\n${shown}`;
  }
};

class SyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this, p = this.plugin, s = p.settings;
    containerEl.empty();
    const text = (name, desc, key, placeholder, clean = v => v.trim()) => new Setting(containerEl)
      .setName(name).setDesc(desc)
      .addText(t => t.setPlaceholder(placeholder).setValue(s[key]).onChange(async v => {
        s[key] = clean(v);
        await p.saveSettings();
      }));

    text('Token', 'Fine-grained personal access token with Contents read/write on this one repo. Stored in this plugin\'s data.json, which is never synced.', 'token', 'github_pat_…')
      .components[0].inputEl.type = 'password';
    text('Repo', 'owner/name', 'repo', 'zcsop1206/notebook-sync-test');
    text('Branch', '', 'branch', 'main');
    text('Vault folder', 'Folder in this vault to sync. Empty means the whole vault.', 'vaultFolder', 'notebook', trimSlashes);
    text('Repo folder', 'Folder in the repo it maps to. Empty means the repo root.', 'repoFolder', 'src/content/notebook', trimSlashes);
    text('Device name', 'Used in commit messages and conflict copy names.', 'device', 'iPad');
    new Setting(containerEl)
      .setName('Ignore')
      .setDesc('Never synced in either direction. This plugin\'s data.json, .git/ and .trash/ are always ignored.')
      .addTextArea(t => {
        t.setValue(s.ignore).onChange(async v => { s.ignore = v; await p.saveSettings(); });
        t.inputEl.rows = 10;
        t.inputEl.style.width = '100%';
      });

    const result = containerEl.createEl('p', { cls: 'setting-item-description' });
    const run = (label, fn) => b => b.setButtonText(label).onClick(async () => {
      b.setDisabled(true);
      result.setText(`${label}…`);
      result.setText(await fn());
      b.setDisabled(false);
    });
    new Setting(containerEl)
      .setName('Check connection')
      .setDesc('Reads the repo, branch and folder. Writes nothing.')
      .addButton(run('Check', () => p.checkConnection()));
    new Setting(containerEl)
      .setName('Sync')
      .setDesc('Pull only brings GitHub\'s changes here. Sync also pushes this vault\'s changes.')
      .addButton(run('Pull only', () => p.sync({ push: false })))
      .addButton(run('Sync', () => p.sync()));
    new Setting(containerEl)
      .setName('Forget sync history')
      .setDesc('The next sync treats both sides as new: nothing is deleted, and files that differ are kept as conflict copies.')
      .addButton(b => b.setButtonText('Forget').onClick(async () => {
        p.state = {};
        await p.save();
        result.setText('Sync history forgotten');
      }));
    containerEl.appendChild(result);
  }
}
