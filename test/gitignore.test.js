'use strict';
// The .gitignore matcher in main.js. Runs offline:
//   node --test test/

const test = require('node:test'), assert = require('node:assert/strict'), Module = require('module');

// main.js requires 'obsidian', which only exists inside Obsidian. The same stand-in trick as run_sync_test.js.
class Plugin { constructor(app, manifest) { this.app = app; this.manifest = manifest; } async loadData() { return null; } addSettingTab() {} addRibbonIcon() {} addCommand() {} }
const obsidian = { Plugin, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, Modal: class {}, Platform: {} };
const load = Module._load;
Module._load = function (req, ...rest) { return req === 'obsidian' ? obsidian : load.call(this, req, ...rest); };
const SyncPlugin = require('../main.js');
Module._load = load;
const { parseGitignore, gitignoreMatcher } = SyncPlugin.__test;

// One .gitignore at the repo root, or several as [[text, dir], ...].
const m = spec => gitignoreMatcher(typeof spec === 'string' ? [parseGitignore(spec)] : spec.map(([t, d]) => parseGitignore(t, d)));
const yes = (match, ...paths) => { for (const p of paths) assert.equal(match(p), true, `${p} should be ignored`); };
const no = (match, ...paths) => { for (const p of paths) assert.equal(match(p), false, `${p} should not be ignored`); };

test('blank lines and comments are skipped, \\# is a literal #', () => {
  const g = m('\n# a.md\n   \n\\#b.md\n');
  no(g, 'a.md', '# a.md');
  yes(g, '#b.md');
});

test('trailing spaces are trimmed unless escaped', () => {
  yes(m('a.md   '), 'a.md');
  const g = m('b\\ ');
  yes(g, 'b ');
  no(g, 'b');
});

test('a pattern without a slash matches at any depth', () => {
  const g = m('*.log\nthumbs.db');
  yes(g, 'a.log', 'x/y/a.log', 'thumbs.db', 'x/thumbs.db');
  no(g, 'a.logx', 'log', 'x/thumbs.dbx');
});

test('a slash other than a trailing one anchors the pattern', () => {
  const g = m('/build\ndoc/frotz');
  yes(g, 'build', 'build/out.js', 'doc/frotz', 'doc/frotz/x');
  no(g, 'src/build', 'src/build/out.js', 'a/doc/frotz');
});

test('a trailing slash matches folders only, and so everything inside them', () => {
  const g = m('scratch/');
  yes(g, 'scratch/x.md', 'a/scratch/y/z.md', 'scratch/');
  no(g, 'scratch', 'a/scratch', 'scratchpad/x.md');
});

test('* does not cross a slash', () => {
  const g = m('/a/*.md');
  yes(g, 'a/x.md');
  no(g, 'a/b/x.md', 'x.md');
  const h = m('foo*bar');
  yes(h, 'fooXbar', 'd/foobar');
  no(h, 'foo/bar');
});

test('** crosses folders', () => {
  const lead = m('**/cache');
  yes(lead, 'cache', 'a/b/cache', 'a/cache/x');
  const mid = m('a/**/b.md');
  yes(mid, 'a/b.md', 'a/x/b.md', 'a/x/y/b.md');
  no(mid, 'z/a/b.md', 'a/xb.md');
  const tail = m('logs/**');
  yes(tail, 'logs/x', 'logs/x/y/z');
  no(tail, 'logs', 'a/logs/x');
});

test('? and character classes', () => {
  const g = m('file?.txt\nv[0-9].md\nn[!a].md\n[ab]c');
  yes(g, 'file1.txt', 'v7.md', 'nb.md', 'ac', 'x/bc');
  no(g, 'file12.txt', 'file/.txt', 'vx.md', 'na.md', 'cc');
});

test('negation: the last matching rule wins', () => {
  const g = m('*.md\n!keep.md');
  yes(g, 'a.md', 'x/a.md');
  no(g, 'keep.md', 'x/keep.md');
  const h = m('!keep.md\n*.md');
  yes(h, 'keep.md');
});

test('nothing inside an ignored folder can be re-included', () => {
  const g = m('secret/\n!secret/ok.md');
  yes(g, 'secret/ok.md', 'secret/other.md');
  const h = m('/*\n!/notes');
  yes(h, 'README.md', 'src/x.js');
  no(h, 'notes/a.md', 'notes/deep/b.md');
});

test('a nested .gitignore applies only below its folder, relative to it', () => {
  const g = m([['*.log', ''], ['*.tmp\n/top.md\nbuild/', 'sub']]);
  yes(g, 'sub/x.tmp', 'sub/deep/x.tmp', 'sub/top.md', 'sub/build/a', 'x.log', 'sub/x.log');
  no(g, 'x.tmp', 'other/x.tmp', 'top.md', 'sub/deep/top.md', 'build/a', 'subway/x.tmp');
});

test('a deeper .gitignore overrides a shallower one', () => {
  const g = m([['!*.md', 'notes'], ['*.md', '']]); // given out of order on purpose
  yes(g, 'a.md', 'other/a.md');
  no(g, 'notes/a.md', 'notes/deep/a.md');
});

test('the plugin prefixes synced paths with the repo folder', async () => {
  const p = new SyncPlugin({ vault: { adapter: {}, configDir: '.obsidian' } }, { id: 'github-api-sync' });
  await p.onload();
  Object.assign(p.settings, { repoFolder: 'src/notes' });
  p.addGitignore('remote', '/src/notes/draft.md\n/top.md\nscratch/\n', '');
  p.addGitignore('local', '*.tmp\n/private.md\n', 'src/notes');
  assert.equal(p.gitIgnored('draft.md'), true, 'root rule anchored at src/notes/draft.md');
  assert.equal(p.gitIgnored('top.md'), false, 'root rule /top.md is the repo root, not the synced folder');
  assert.equal(p.gitIgnored('a/scratch/x.md'), true);
  assert.equal(p.gitIgnored('a/scratch/'), true, 'a folder, as scanLocal asks');
  assert.equal(p.gitIgnored('x.tmp'), true, 'the vault copy of src/notes/.gitignore');
  assert.equal(p.gitIgnored('private.md'), true);
  assert.equal(p.gitIgnored('sub/private.md'), false);
  p.settings.gitignore = false;
  assert.equal(p.gitIgnored('draft.md'), false, 'the setting turns it off');
});

test('a whole-repo sync uses paths as they are', async () => {
  const p = new SyncPlugin({ vault: { adapter: {}, configDir: '.obsidian' } }, { id: 'github-api-sync' });
  await p.onload();
  p.addGitignore('remote', '/top.md\n', '');
  assert.equal(p.gitIgnored('top.md'), true);
  assert.equal(p.gitIgnored('a/top.md'), false);
});
