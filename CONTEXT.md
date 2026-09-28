# Context for working on this repo

Read this first. It records what the plugin is for, what has been decided, what exists, and what comes next. Update it when a decision changes.

## Goal

Keep an Obsidian vault in sync with a GitHub repo on devices that can't run git, starting with the iPad.

It is part of an engineering notebook that feeds a portfolio site (`zcsop1206/EngineeringPortfolio`, Astro, deployed to GitHub Pages on push to `main`). The end state: every device (iPad and laptop now, others later) holds a copy of the portfolio and can update it. The laptop uses plain git from a terminal or IDE. This plugin covers the devices where that isn't possible.

Ink and audio live in a separate plugin, `zcsop1206/obsidian-notebook`. That repo's `CONTEXT.md` holds the notebook-wide decisions (vault layout, ink format, privacy); this file covers sync only.

## Constraints

- Development happens on Windows. No Mac.
- No Working Copy (paid) and no Obsidian Git (it hung Obsidian on the laptop before).
- Runs inside Obsidian's iOS web view: web APIs only, no Node modules (`fs`, `child_process`), no `.git` folder. Network calls go through Obsidian's `requestUrl`, which avoids CORS limits on mobile.
- The portfolio repo is public. Nothing private may be pushed by accident.

## Decisions made

| Decision | Choice | Why |
|---|---|---|
| Sync mechanism | GitHub REST API | No `.git` on the device, no full history download |
| Separate plugin | Its own repo, not part of obsidian-notebook | A different job from ink and audio; it's what lets any future device update the portfolio; it releases and is tested on its own |
| Platforms | Only needs to work on mobile | The laptop uses plain git. Desktop Obsidian may still run it for testing, so `isDesktopOnly` stays false |
| Delivery | BRAT, from this repo's GitHub releases | Same as the notebook plugin |
| Coexisting with git | Both sides make ordinary commits on the same branch | The laptop pulls before working and pushes after; nothing special needed |

## Open questions

- **What the device's vault holds:** the whole portfolio repo, or only a notebook folder inside it. The whole repo brings the site's code onto the iPad, where it's of little use, so it would need ignoring. The plugin's settings allow either (vault folder ↔ repo folder).

## How sync works (0.1.0)

- **Auth:** a fine-grained personal access token with Contents read/write on one repo, entered in the plugin settings and stored in the plugin's `data.json`.
  - That file sits at `.obsidian/plugins/github-api-sync/data.json`. It must never be synced or committed: the plugin always ignores it, and the laptop's `.gitignore` must exclude it too if `.obsidian/` lives in the repo.
- **Config:** repo (`owner/name`), branch, the vault folder and the repo folder it maps to, a device name, ignore rules, and whether to honour the repo's `.gitignore` (on by default).
- **State** (in `data.json` next to the settings):
  - the commit the last sync ended on;
  - the base: each synced file's git blob SHA at that sync;
  - a local cache of mtime, size and SHA, so unchanged files aren't re-read and rehashed;
  - a key made of repo, branch and both folders. Changing any of them resets the state, so the next sync is a first sync.
- **Each sync:**
  1. Read the branch head and its full tree (`git/trees/{sha}?recursive=1`), then download the `.gitignore` files that can apply to the synced folder (see below), then hash the vault folder (git blob SHA-1 = `sha1("blob <len>\0" + bytes)`).
  2. Compare each path three ways (base, vault, GitHub):
     - changed only on GitHub → pulled;
     - changed only in the vault → pushed;
     - changed on both → GitHub's version keeps the path, the vault's is kept as `name (conflict <device> <date>).ext` and pushed;
     - a change beats a delete on the other side.
  3. Pull: download changed blobs; files deleted on GitHub go to the vault's `.trash` via `trashLocal`.
  4. Push: upload only blobs GitHub doesn't already have, make a tree on the head's tree (`sha: null` for deletes) and one commit, then move the branch without force. If the branch moved meanwhile, the whole sync starts again (up to 3 tries).
  5. Save the state only after everything succeeded. A sync that stops partway is safe to repeat.
- **First sync** (empty base): nothing is deleted on either side; files that differ become conflict copies.
- **Guards:**
  - Deleting more than 10 files, and more than 25% of the synced files, asks first.
  - If the vault folder has vanished after a sync, it refuses to run, so a missing folder can't delete everything on GitHub.
  - An uploaded blob whose SHA doesn't match the hash stops the sync (the file changed mid-sync, or the hashing is wrong).
- **Pull only:** the same, minus the push. Local changes are held back and go out on the next full sync.
- **Ignore rules** (editable, apply to both sides, relative to the synced folder): `*.ext` = that extension anywhere; `name/` = that folder anywhere; anything else = that exact path, or that file name anywhere if it has no slash. Defaults: `.obsidian/`, `private/`, and `m4a`, `webm`, `ogg`, `mp3`, `wav`. Always ignored: this plugin's `data.json`, `.git/`, `.trash/`, `.DS_Store`.
- **`.gitignore`** (after 0.1.0, not released yet; setting "Honour the repo's .gitignore", on by default): the portfolio repo is public and its `.gitignore` is the single source of truth for what must never be published, so the plugin applies it too, on top of its own rules. A path ignored by either is neither pulled nor pushed.
  - Which files: the root `.gitignore`, any `.gitignore` in the repo folder or a folder above it, and any below it. GitHub's copies come from the tree (blobs, cached by SHA in memory); the vault's copies are read as the scan enters each folder, so a `.gitignore` edited on the device applies in the same sync. Both are applied, and a path either copy ignores is ignored, so a stale copy can't let a file out.
  - Paths are matched repo-relative (the repo folder is prefixed), so the root `.gitignore` applies as git would apply it.
  - Syntax: comments, blank lines, trailing spaces (unless escaped), `!` negation, anchoring by a leading or middle slash, trailing `/` for folders, `*` and `?` within one path segment, `**`, and `[...]` classes. Deeper files beat shallower ones, the last matching rule wins, and nothing inside an ignored folder can be re-included. Case-sensitive, as git is on GitHub. Checked against `git check-ignore` on a set of patterns.
  - A `.gitignore` itself syncs like any other file.
  - Local files held back by `.gitignore` are counted and the result notice says so ("2 local files skipped by .gitignore"). An ignored folder is still walked (listed, not read) to count them.
  - A file that was synced before a rule started ignoring it stays on GitHub; the plugin just stops syncing it. Removing it from the repo is a job for git on the laptop.
- **Renames** are a delete plus an add. The content isn't uploaded again, because its blob already exists on GitHub.
- **Symlinks** (mode `120000`) and submodules in the repo are skipped.
- **UI:**
  - Ribbon icon and command "Sync now (pull and push)";
  - command "Pull only";
  - command "Check GitHub connection";
  - buttons for all three in settings, plus "Forget sync history", which resets the state;
  - a progress notice while syncing and a one-line result afterwards.
- **Limits:**
  - One GitHub request per changed file, four at a time, so the first sync of a big vault takes a while.
  - Repos whose tree is too large for one request (GitHub truncates past about 100k entries) aren't supported.
  - There is no cancel button yet.
  - Sync is manual: it doesn't run on a timer or when Obsidian opens.

## Verified so far

`test/gitignore.test.js` (`node --test`) covers the `.gitignore` matcher offline.

`test/run_sync_test.js` against the real throwaway repo `zcsop1206/notebook-sync-test` (private). Each run uses its own temporary branch cut from the repo's `seed` tag (the seed commit), so it doesn't depend on what `main` holds, and deletes the branch afterwards. All 23 checks pass:
- first sync, ignore rules, binary files byte-exact;
- push of an edit, an add and a delete;
- conflicts on first sync and on a normal sync;
- pull only;
- remote delete to `.trash`;
- the branch moving mid-push;
- the mass-delete prompt, both cancelled and confirmed;
- folder mapping;
- the missing-folder guard;
- `.gitignore`: a new one in the vault applies in the same sync, ignored local files aren't pushed and are counted, an ignored file on GitHub isn't pulled, and with the setting off both go through.

Not yet run inside Obsidian. The settings tab, the `requestUrl` and adapter behaviour on iOS (including `list('/')` for a whole-vault sync), `crypto.subtle` in the iOS web view and `trashLocal` on mobile are all untested there.

## Next steps

1. Install 0.1.0 on the iPad through BRAT. Enter a token scoped to `zcsop1206/notebook-sync-test` only, then check the connection and sync. Edit on the iPad and on the laptop (plain git clone of the test repo) and sync back and forth, including a conflict.
2. Settle the open question above, then point it at the real repo.
3. Consider: sync on open or on a timer, a cancel button, a status indicator for unsynced changes.

## Repo mechanics

- **Files:** `main.js` and `manifest.json` at the root, plus `versions.json`. Plain CommonJS, no build step; add esbuild + TypeScript when the code outgrows one file.
- **Release:** bump `version` in `manifest.json` and add it to `versions.json`, commit, then push a tag equal to the version. `.github/workflows/release.yml` checks the tag matches the manifest and attaches `main.js` and `manifest.json` to a release. BRAT picks it up.
