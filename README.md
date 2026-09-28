# obsidian-github-sync

An Obsidian plugin that syncs a vault folder with a GitHub repo through the REST API, for devices that can't run git (the iPad). Laptops use plain git.

- **Sync** pulls GitHub's changes, then pushes the vault's changes as one commit.
- **Pull only** brings GitHub's changes without pushing anything.
- If a file changed on both sides, GitHub's version keeps the name and yours is kept next to it as `name (conflict <device> <date>).md`. Nothing is overwritten silently.
- Files deleted on GitHub go to the vault's `.trash` folder. Deleting more than 10 files, and more than a quarter of what's synced, asks first.

See `CONTEXT.md` for the design and status.

## Install on the iPad

1. Install **BRAT** from Community plugins and enable it.
2. BRAT → Add beta plugin → `zcsop1206/obsidian-github-sync`.
3. Enable **GitHub API sync** under Community plugins.
4. Create a fine-grained personal access token with **Contents: read and write** on one repo only. Paste it into the plugin settings, fill in the repo and branch, and press **Check**.
5. Press **Sync**, or use the ribbon icon or the command "Sync now (pull and push)".

The settings also set which vault folder maps to which repo folder, the device name used in commit messages, and the ignore rules. By default `.obsidian/`, `private/` and audio files are ignored. On top of those, the plugin honours the repo's `.gitignore` files (GitHub's copies and the vault's) in both directions, so a file git ignores on the laptop isn't pushed from the iPad either; the result notice says how many local files it held back. A switch in the settings turns this off.

## Test

```
node --test
node test/run_sync_test.js owner/repo
```

The first runs the offline tests (the `.gitignore` matcher). The second runs the plugin in Node against a real throwaway repo (`zcsop1206/notebook-sync-test`), on a temporary branch it deletes afterwards. It uses `GITHUB_TOKEN`, or else `gh auth token`.

## Release

Bump `version` in `manifest.json` and `versions.json`, commit, then push a tag with the same version. The workflow attaches `main.js` and `manifest.json` to a GitHub release.
