# GitHub REST Sync

An Obsidian plugin that syncs a vault with a GitHub repo via the REST API, built specifically for mobile devices (phones/tablets).

## Why not use an existing git-sync plugin from the community

Most "sync your vault to GitHub" plugins (e.g. Obsidian Git) rely on [isomorphic-git](https://isomorphic-git.org/) to simulate a full git protocol (clone/pull/push) on-device. That works fine on desktop, but on mobile:

- Obsidian Git's own README states plainly that "the git implementation on mobile is very unstable" and recommends against using it there
- Testing another mobile-focused sync plugin turned up a dependency that calls `require("buffer")` (a Node.js-only API), which doesn't exist in the mobile JS runtime at all - it crashes on load
- Simulating a git engine on a memory-constrained phone tends to crash or hang the app when syncing a large number of files

This plugin deliberately **avoids the git protocol entirely**. It calls GitHub's REST / Git Data API directly to read and write file content, so there's no git engine to simulate on-device and no reliance on any Node.js-only API (the esbuild config pins `platform: "browser"`, so any accidental Node-only import fails at build time instead of crashing silently on a phone).

## Features

- **Pure REST API** - identical behavior on desktop, iOS, and Android; no system git required
- **Three-way diff**: tracks "the version both sides agreed on after the last sync" so it can correctly tell apart new files, edits, and deletions. Renames are handled for free (they just look like a delete + a create to the diff logic)
- **Conflict detection**: when both sides changed the same file differently, it never auto-overwrites - a resolution modal opens with a side-by-side content preview so you can pick which version to keep
- **Batched sync**: pushes are packed into a handful of commits via the git tree/commit API (not one commit per file), and pulls run in parallel batches - stays reliable even with a large number of files
- **Automation**:
  - Syncs once automatically when the app opens
  - Periodic sync (defaults to every 10 minutes, adjustable to 1-1440 minutes in settings)
  - Syncs automatically on file create/delete/rename, debounced by 3 seconds
  - All of the above are the quiet **Quick Sync** variant (no popup at all when nothing changed)
- **Manual sync**: the ribbon icon / command palette entry is **Normal Sync**, which shows a progress modal while it runs

## Installation (via BRAT)

This is a personal project, not something the official Obsidian community plugin directory lists. Install it through [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Search for and install **BRAT** from Obsidian's Community Plugins
2. In BRAT's settings, click "Add beta plugin"
3. Enter the repository: `https://github.com/yaochi0362/obsidian-github-rest-sync` (public repo, no GitHub token needed to install)
4. Enable "GitHub REST Sync"

## Settings

| Field | Description |
| --- | --- |
| Repository URL | The GitHub repo to sync with - paste the full URL and it auto-parses owner/repo |
| Branch | Defaults to `main` |
| GitHub Personal Access Token | Needs **Contents: Read and write** access to the target repo (write is required for pushing). Use a fine-grained token scoped to just this one repo, not a classic token with full account access |
| Sync interval | 1-1440 minutes, defaults to 10 |

Once the URL and token are filled in, the settings page automatically shows a connection test result (success, or the reason it failed).

## Known limitations

- **Real content conflicts are never auto-resolved**: when both sides changed the same file differently, a resolution modal lets you pick a side manually - there's no automatic content merge
- **No sync on app background/close**: iOS suspends a WebView's JS execution almost immediately once backgrounded, and a third-party plugin has no way to extend that window. Attempting this would mostly fail silently, so it's deliberately not implemented
- **No pagination for very large repos**: if a repo has enough files that GitHub's tree API response gets truncated (`truncated: true`), the plugin currently just shows a warning - the diff may be incomplete
