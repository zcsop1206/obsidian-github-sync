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

## Design (not built yet)

- **Auth:** a fine-grained personal access token with Contents read/write on one repo, entered in the plugin settings and stored in the plugin's `data.json`.
  - That file sits at `.obsidian/plugins/github-api-sync/data.json`. It must never be synced or committed: the plugin always ignores it, and the laptop's `.gitignore` must exclude it too if `.obsidian/` lives in the repo.
- **Config:** repo (`owner/name`), branch, the vault folder and the repo folder it maps to.
- **State:** the last synced commit SHA, plus each file's blob SHA at that commit.
- **Pull:** compare the last synced commit to the branch head (`GET /repos/{o}/{r}/compare/{base}...{head}`, or a tree diff), then download changed blobs.
- **Push:** local changes are files whose content hash differs from the recorded blob SHA (git blob SHA-1 = `sha1("blob <len>\0" + bytes)`). Create blobs, a tree with `base_tree`, and a commit, then update the ref. If the ref moved, pull first and retry.
- **Conflicts:** if a file changed on both sides, keep both (`name (iPad).md`) and show a notice. Never silently overwrite.
- **Deletes and renames** need explicit handling and tests.
- **Never block the editor:** async with a concurrency cap, visible progress, cancellable.
- **What syncs:** only note and attachment extensions, with an ignore list that includes `.obsidian/workspace*.json`, this plugin's `data.json`, audio, and `private/`.
- **Testing:** hard, against a throwaway repo, before it touches real notes. Desktop Obsidian or a headless harness on the laptop is fine for that.

## What exists now (0.0.1, the skeleton)

- Settings tab: token (password field), repo, branch, vault folder, repo folder.
- Command and button "Check GitHub connection": reads the repo, the branch head and the repo folder, and reports what it found or the API error. It can't prove write access without writing, so that's checked on the first push.
- No sync yet.

## Next steps

1. Install on the iPad through BRAT, enter a token for a throwaway repo, run the connection check.
2. Pull only: download the repo folder into the vault folder and record state.
3. Push: detect local changes by blob SHA and commit them.
4. Conflicts, deletes, renames, progress and cancelling.
5. A headless test harness like the notebook plugin's (`test/` there: Playwright, a mock `obsidian` module, an in-memory vault), with `requestUrl` pointed at a fake GitHub.

## Repo mechanics

- **Files:** `main.js` and `manifest.json` at the root, plus `versions.json`. Plain CommonJS, no build step; add esbuild + TypeScript when the code outgrows one file.
- **Release:** bump `version` in `manifest.json` and add it to `versions.json`, commit, then push a tag equal to the version. `.github/workflows/release.yml` checks the tag matches the manifest and attaches `main.js` and `manifest.json` to a release. BRAT picks it up.
