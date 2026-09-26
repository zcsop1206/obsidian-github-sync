# obsidian-github-sync

An Obsidian plugin that syncs a vault folder with a GitHub repo through the REST API, for devices that can't run git (the iPad). Laptops use plain git.

Right now it is a skeleton: settings and a connection check. Sync itself is not built yet. See `CONTEXT.md`.

## Install on the iPad

1. Install **BRAT** from Community plugins and enable it.
2. BRAT → Add beta plugin → `zcsop1206/obsidian-github-sync`.
3. Enable **GitHub API sync** under Community plugins.
4. Create a fine-grained personal access token with Contents read/write on one repo, paste it into the plugin settings, fill in the repo and branch, and press **Check**.

## Release

Bump `version` in `manifest.json` and `versions.json`, commit, then push a tag with the same version. The workflow attaches `main.js` and `manifest.json` to a GitHub release.
