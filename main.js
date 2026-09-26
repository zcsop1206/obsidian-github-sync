'use strict';
/*
 * GitHub API sync. Syncs a vault folder with a folder in a GitHub repo through the
 * REST API, for devices that can't run git (the iPad). Laptops use plain git.
 * 0.0.1 is the skeleton: settings and a connection check. Sync itself comes next.
 */

const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } = require('obsidian');

const DEFAULTS = { token: '', repo: '', branch: 'main', vaultFolder: '', repoFolder: '' };

const trimSlashes = s => s.trim().replace(/^\/+|\/+$/g, '');

// One GitHub REST call. Returns parsed JSON or throws an Error with GitHub's message.
async function gh(token, path) {
  const res = await requestUrl({
    url: `https://api.github.com${path}`,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    throw: false,
  });
  let body = null;
  try { body = res.json; } catch (e) { /* not JSON */ }
  if (res.status >= 400) {
    const err = new Error(`${res.status}${body && body.message ? `: ${body.message}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

module.exports = class GitHubApiSync extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.addSettingTab(new SyncSettingTab(this.app, this));
    this.addCommand({ id: 'check-connection', name: 'Check GitHub connection', callback: () => this.checkConnection() });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // Reads the repo, the branch head and the repo folder. Returns a one-line report.
  async checkConnection() {
    const { token, repo, branch, repoFolder } = this.settings;
    let report;
    if (!token) report = 'No token set';
    else if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) report = 'Repo must look like owner/name';
    else {
      try {
        const r = await gh(token, `/repos/${repo}`);
        const b = await gh(token, `/repos/${repo}/branches/${encodeURIComponent(branch)}`);
        let where = 'repo root';
        if (repoFolder) {
          const path = repoFolder.split('/').map(encodeURIComponent).join('/');
          const items = await gh(token, `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
          where = Array.isArray(items) ? `${repoFolder}/ (${items.length} entries)` : `${repoFolder} is a file, not a folder`;
        }
        report = `Connected to ${r.full_name} (${r.private ? 'private' : 'public'}), ${branch} at ${b.commit.sha.slice(0, 7)}, ${where}`;
      } catch (e) {
        report = e.status === 404 ? `Not found (${e.message}): check the repo, branch, folder and the token's repo access`
          : e.status === 401 ? 'Token rejected (401): it may be wrong or expired'
          : `GitHub error ${e.message}`;
      }
    }
    new Notice(report, 8000);
    return report;
  }
};

class SyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this, s = this.plugin.settings;
    containerEl.empty();
    const text = (name, desc, key, placeholder, clean = v => v.trim()) => new Setting(containerEl)
      .setName(name).setDesc(desc)
      .addText(t => t.setPlaceholder(placeholder).setValue(s[key]).onChange(async v => {
        s[key] = clean(v);
        await this.plugin.saveSettings();
      }));

    text('Token', 'Fine-grained personal access token with Contents read/write on this one repo. Stored in this plugin\'s data.json, which is never synced.', 'token', 'github_pat_…')
      .components[0].inputEl.type = 'password';
    text('Repo', 'owner/name', 'repo', 'zcsop1206/EngineeringPortfolio');
    text('Branch', '', 'branch', 'main');
    text('Vault folder', 'Folder in this vault to sync. Empty means the whole vault.', 'vaultFolder', 'notebook', trimSlashes);
    text('Repo folder', 'Folder in the repo it maps to. Empty means the repo root.', 'repoFolder', 'src/content/notebook', trimSlashes);

    const result = containerEl.createEl('p', { cls: 'setting-item-description' });
    new Setting(containerEl)
      .setName('Check connection')
      .setDesc('Reads the repo, branch and folder. Writes nothing.')
      .addButton(b => b.setButtonText('Check').onClick(async () => {
        b.setDisabled(true);
        result.setText('Checking…');
        result.setText(await this.plugin.checkConnection());
        b.setDisabled(false);
      }));
    containerEl.appendChild(result);
  }
}
