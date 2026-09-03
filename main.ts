import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl, normalizePath } from "obsidian";

const SPINNER_STYLE_ID = "multi-device-sync-spinner-style";

function ensureSpinnerStyle() {
	if (document.getElementById(SPINNER_STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = SPINNER_STYLE_ID;
	style.textContent = `
		.mds-spinner {
			width: 28px;
			height: 28px;
			border-radius: 50%;
			border: 3px solid var(--background-modifier-border);
			border-top-color: var(--interactive-accent);
			animation: mds-spin 0.8s linear infinite;
			margin: 0 auto 12px;
		}
		@keyframes mds-spin {
			to { transform: rotate(360deg); }
		}
	`;
	document.head.appendChild(style);
}

class ProgressModal extends Modal {
	private messageEl: HTMLElement;
	private allowClose = false;

	constructor(
		app: App,
		private title: string,
	) {
		super(app);
	}

	onOpen() {
		ensureSpinnerStyle();
		this.titleEl.setText(this.title);
		this.contentEl.createDiv({ cls: "mds-spinner" });
		this.messageEl = this.contentEl.createEl("div", { text: "Preparing…" });
		this.messageEl.style.textAlign = "center";
		this.contentEl.createEl("div", {
			text: "In progress, please don't close this window",
			cls: "setting-item-description",
		}).style.textAlign = "center";
		// Remove the close button to prevent accidental taps - closing the background overlay would
		// still call close(), which we override below so it can't be dismissed while running.
		this.modalEl.querySelector(".modal-close-button")?.remove();
	}

	setMessage(text: string) {
		this.messageEl?.setText(text);
	}

	// Call this when the operation actually finishes, instead of close() - clicking the background
	// overlay also calls close(), and we override it here to block dismissal while running.
	finish() {
		this.allowClose = true;
		this.close();
	}

	close() {
		if (!this.allowClose) return;
		super.close();
	}
}

// The last confirmed matching state between local and GitHub (path -> sha).
// Needed to tell "this is a new file" apart from "this file was deleted" - looking only at
// whether the path currently exists on either side can't distinguish the two.
type SyncState = Record<string, string>;

interface MultiDeviceSyncSettings {
	repoUrl: string;
	branch: string;
	token: string;
	syncState: SyncState;
	syncIntervalMinutes: number;
	// False only for a device that has never completed a sync cycle. Gates the very first sync
	// to pull-only (see runSyncCycle) so a fresh install - possibly with stale/orphaned local
	// files that were already cleaned up elsewhere - doesn't push them back up as "new" before
	// the user has had a chance to review what's actually local-only.
	firstSyncDone: boolean;
}

const DEFAULT_SETTINGS: MultiDeviceSyncSettings = {
	repoUrl: "",
	branch: "main",
	token: "",
	syncState: {},
	syncIntervalMinutes: 10,
	firstSyncDone: false,
};

const MIN_SYNC_INTERVAL_MINUTES = 1;
const MAX_SYNC_INTERVAL_MINUTES = 1440;

// Debounce for create/modify/delete/rename events, and also the "still being edited" window a
// sync excludes a path for - kept as one constant so they can't drift apart (see
// recentlyModified above).
const QUICK_SYNC_DEBOUNCE_MS = 3000;

interface ParsedRepo {
	owner: string;
	repo: string;
}

// Supports https://github.com/owner/repo, a trailing .git, a trailing slash, and the
// git@github.com:owner/repo.git SSH form.
function parseGithubRepoUrl(url: string): ParsedRepo | null {
	const match = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
	if (!match) return null;
	return { owner: match[1], repo: match[2] };
}

// Known GitHub token prefixes: ghp_ = classic PAT, github_pat_ = fine-grained PAT,
// gho_/ghu_/ghs_/ghr_ = OAuth family. Also does a rough length check; anything clearly
// too short is treated as a format error.
function looksLikeGithubToken(token: string): boolean {
	return /^(ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{10,}$/.test(token);
}

const REPORT_FILE_PATH = normalizePath("GitHub REST Sync Report.md");

// Files that get regenerated with different content on every run: excluded from the diff,
// otherwise they'd permanently show up as "content differs".
const EXCLUDED_PATHS = [REPORT_FILE_PATH];

interface GitTreeEntry {
	path: string;
	type: string;
	sha: string;
	size?: number;
}

type ChangeAction = "create" | "modify" | "delete";

interface PlannedChange {
	path: string;
	action: ChangeAction;
}

interface DiffResult {
	toPush: PlannedChange[]; // Changed locally, not on GitHub: apply to GitHub
	toPull: PlannedChange[]; // Changed on GitHub, not locally: apply locally
	conflicts: string[]; // Changed on both sides, and differently: not handled automatically
	inSyncCount: number;
}

// Any path with a dot-prefixed segment (.obsidian/, .git/, .trash/, .claude/, .vscode/, ...) is
// never synced. This isn't just those three well-known folders: it matches Obsidian's own default
// behavior of hiding dotfiles/dotfolders from the vault entirely, which is what made scanning via
// this.app.vault.getFiles() safe before this plugin switched to a real filesystem walk (see
// listAllFilePaths) - that switch fixed a staleness bug but also stopped getting this exclusion for
// free, which is exactly how a git worktree checked out at .claude/worktrees/<name>/ (a real,
// legitimate directory, just not vault content) ended up being diffed as ~1100 new files, including
// a nested .git entry GitHub's tree API rejects outright as a malformed path component.
function isExcluded(path: string): boolean {
	if (EXCLUDED_PATHS.includes(path)) return true;
	return path.split("/").some((segment) => segment.startsWith("."));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Random delay before a branch-race retry: spreads out repeated collisions with another
// device's push instead of retrying at the exact same instant every time.
function retryJitterMs(): number {
	return 300 + Math.floor(Math.random() * 500);
}

function arrayBufferToBase64(bytes: ArrayBuffer): string {
	const uint8 = new Uint8Array(bytes);
	let binary = "";
	const chunkSize = 0x8000; // avoids blowing the call stack by apply()-ing too many arguments for large files
	for (let i = 0; i < uint8.length; i += chunkSize) {
		binary += String.fromCharCode(...uint8.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const binary = atob(base64.replace(/\n/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

async function gitBlobSha1(bytes: ArrayBuffer): Promise<string> {
	const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
	const combined = new Uint8Array(header.byteLength + bytes.byteLength);
	combined.set(header, 0);
	combined.set(new Uint8Array(bytes), header.byteLength);
	const digest = await crypto.subtle.digest("SHA-1", combined);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export default class MultiDeviceSyncPlugin extends Plugin {
	settings: MultiDeviceSyncSettings;
	private syncing = false;
	private quickSyncDebounceTimer: number | null = null;
	private syncIntervalId: number | null = null;
	// path -> last time Obsidian told us it changed. A sync in progress reads this to skip any
	// path still inside its settle window, so it never diffs/pushes/pulls a file mid-edit - the
	// window matches the debounce delay below so a debounced sync's own trigger file has just
	// cleared it by the time the sync actually runs.
	private recentlyModified = new Map<string, number>();

	// Single entry point: blocks overlapping runs (e.g. tapping the button again mid-batch-push
	// would have both runs fast-forwarding the branch and stepping on each other), and keeps one
	// progress modal open for the whole operation, updating its text instead of firing a stream
	// of separate Notices.
	private async withProgress(title: string, fn: (modal: ProgressModal) => Promise<string>) {
		if (this.syncing) {
			new Notice("A sync is already running, please wait");
			return;
		}
		this.syncing = true;
		const modal = new ProgressModal(this.app, title);
		modal.open();
		try {
			const finalMessage = await fn(modal);
			new Notice(finalMessage);
		} catch (error) {
			console.error(`[multi-device-sync] ${title} failed`, error);
			new Notice(`${title} failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			modal.finish();
			this.syncing = false;
		}
	}

	// BRAT's mobile update flow doesn't reliably unload the previous version first, so ribbon
	// items registered by an old version can linger and stack up release after release.
	// Regardless of whether the last unload was clean, proactively clear any old ones first.
	private removeStaleRibbonIcons() {
		document
			.querySelectorAll('[aria-label^="Multi-Device Sync"], [aria-label^="GitHub REST Sync"]')
			.forEach((el) => el.remove());
	}

	// Same idea for commands - some ids were reused/removed across past versions. Purge them by
	// id via the internal app API directly, rather than depending on the previous onunload
	// having run cleanly.
	private removeStaleCommands() {
		const staleIds = ["multi-device-sync-dry-run", "multi-device-sync-pull-new", "multi-device-sync-push-new"];
		const commands = (this.app as unknown as { commands: { removeCommand: (id: string) => void } }).commands;
		for (const id of staleIds) {
			try {
				commands.removeCommand(`${this.manifest.id}:${id}`);
			} catch {
				// throws if the command doesn't exist yet, which is fine to ignore
			}
		}
	}

	async onload() {
		console.log("[multi-device-sync] plugin loaded");
		await this.loadSettings();
		this.removeStaleRibbonIcons();
		this.removeStaleCommands();

		this.addSettingTab(new MultiDeviceSyncSettingTab(this.app, this));

		this.addRibbonIcon("refresh-cw", "GitHub REST Sync: One-Click Sync", () => {
			this.syncAll();
		});

		this.addCommand({
			id: "github-rest-sync-ping",
			name: "GitHub REST Sync: Test Installation",
			callback: () => {
				new Notice("GitHub REST Sync installed successfully ✅");
			},
		});

		this.addCommand({
			id: "github-rest-sync-all",
			name: "GitHub REST Sync: One-Click Sync (Push + Pull)",
			callback: () => this.syncAll(),
		});

		this.setupSyncInterval();

		// Only start after onLayoutReady: when a vault first opens, Obsidian replays a "create"
		// event for every pre-existing file, so registering too early would misread that as a
		// flood of new files and fire sync repeatedly.
		this.app.workspace.onLayoutReady(() => {
			this.quickSync(); // Sync once on open

			this.registerEvent(
				this.app.vault.on("create", (file) => {
					if (isExcluded(file.path)) return;
					this.markRecentlyModified(file.path);
					this.scheduleQuickSync();
				}),
			);
			this.registerEvent(
				this.app.vault.on("modify", (file) => {
					if (isExcluded(file.path)) return;
					this.markRecentlyModified(file.path);
					this.scheduleQuickSync();
				}),
			);
			this.registerEvent(
				this.app.vault.on("delete", (file) => {
					if (isExcluded(file.path)) return;
					// A delete deserves the same settle window as create/modify/rename: a file
					// created and deleted again within a few seconds (an abandoned "Untitled" note,
					// a quick undo-then-redo) should settle as one unit instead of the create and
					// delete landing in two separate sync cycles - which is how a since-deleted file
					// could still end up diffed as a real conflict against GitHub.
					this.markRecentlyModified(file.path);
					this.scheduleQuickSync();
				}),
			);
			this.registerEvent(
				this.app.vault.on("rename", (file, oldPath) => {
					if (isExcluded(file.path) && isExcluded(oldPath)) return;
					this.markRecentlyModified(file.path);
					this.scheduleQuickSync();
				}),
			);
		});

		new Notice("GitHub REST Sync loaded");
	}

	onunload() {
		console.log("[multi-device-sync] plugin unloaded");
		if (this.quickSyncDebounceTimer !== null) {
			window.clearTimeout(this.quickSyncDebounceTimer);
			this.quickSyncDebounceTimer = null;
		}
	}

	// Path of the old plugin folder from when the plugin id was renamed from multi-device-sync
	// to github-rest-sync. One-time migration: on a fresh install (loadData is empty), if the
	// old folder's settings file is still there, read it in as the initial value - this way
	// changing the id/folder name doesn't reset every device's syncState history.
	private static readonly OLD_PLUGIN_ID = "multi-device-sync";

	async loadSettings() {
		const currentData = await this.loadData();
		if (!currentData) {
			const oldDataPath = normalizePath(`.obsidian/plugins/${MultiDeviceSyncPlugin.OLD_PLUGIN_ID}/data.json`);
			if (this.manifest.id !== MultiDeviceSyncPlugin.OLD_PLUGIN_ID && (await this.app.vault.adapter.exists(oldDataPath))) {
				try {
					const oldData = JSON.parse(await this.app.vault.adapter.read(oldDataPath));
					// Inheriting real sync history from the old plugin folder counts as already
					// past the first-sync safety gate, regardless of whether that old data predates
					// the firstSyncDone field.
					this.settings = Object.assign({}, DEFAULT_SETTINGS, oldData, { firstSyncDone: true });
					await this.saveSettings();
					new Notice("Migrated settings and sync history from the previous plugin");
					return;
				} catch (error) {
					console.error("[github-rest-sync] failed to migrate settings from old plugin folder", error);
				}
			}
		}
		this.settings = Object.assign({}, DEFAULT_SETTINGS, currentData);
		// A device that already had saved settings before this field existed has already been
		// syncing normally - only a device with no prior data.json at all is a true first install.
		if (currentData && !("firstSyncDone" in currentData)) {
			this.settings.firstSyncDone = true;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// If a statusEl is provided, write the result into it (color + text) for live display on
	// the settings page.
	async validateToken(statusEl?: HTMLElement) {
		const setStatus = (text: string, color: string) => {
			if (statusEl) {
				statusEl.setText(text);
				statusEl.style.color = color;
			}
		};

		const token = this.settings.token;
		if (!token) {
			setStatus("", "");
			return;
		}

		if (!looksLikeGithubToken(token)) {
			setStatus("❌ Token format looks wrong (GitHub tokens usually start with ghp_ or github_pat_)", "var(--text-error)");
			return;
		}

		const parsed = parseGithubRepoUrl(this.settings.repoUrl);
		if (!parsed) {
			setStatus("⚠️ Format looks fine, but the repository URL isn't valid yet, so the connection can't be tested", "var(--text-warning)");
			return;
		}

		setStatus("⏳ Verifying…", "var(--text-muted)");
		try {
			const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
			const res = await requestUrl({ url, headers: this.githubHeaders(), throw: false });
			if (res.status === 200) {
				const data = res.json as { default_branch: string; private: boolean };
				setStatus(
					`✅ Connected: ${parsed.owner}/${parsed.repo} (${data.private ? "private" : "public"}, default branch: ${data.default_branch})`,
					"var(--text-success)",
				);
			} else if (res.status === 401) {
				setStatus("❌ Token invalid or expired (401)", "var(--text-error)");
			} else if (res.status === 404) {
				setStatus("❌ Repo not found, or the token doesn't have access (404)", "var(--text-error)");
			} else {
				setStatus(`❌ Connection failed (${res.status}): ${res.text}`, "var(--text-error)");
			}
		} catch (error) {
			setStatus(`❌ Connection failed: ${error instanceof Error ? error.message : String(error)}`, "var(--text-error)");
		}
	}

	private githubHeaders(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.settings.token}`,
			Accept: "application/vnd.github+json",
		};
	}

	private async fetchRemoteTree(): Promise<GitTreeEntry[]> {
		const parsed = parseGithubRepoUrl(this.settings.repoUrl);
		if (!parsed) throw new Error("Could not parse the repository URL");
		const { owner, repo } = parsed;
		const { branch } = this.settings;
		const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
		const res = await requestUrl({ url, headers: this.githubHeaders(), throw: false });
		if (res.status === 409) {
			// GitHub returns 409 "Git Repository is empty." for a brand-new repo with no commits
			// yet - not an error, it just means the remote is currently empty; carry on, and the
			// diff will show everything as local-only.
			return [];
		}
		if (res.status !== 200) {
			throw new Error(`GitHub API error (${res.status}): ${res.text}`);
		}
		const data = res.json as { tree: GitTreeEntry[]; truncated: boolean };
		if (data.truncated) {
			new Notice("⚠️ This repo has too many files - GitHub truncated the file list, so the diff may be incomplete");
		}
		return data.tree.filter((entry) => entry.type === "blob" && !isExcluded(entry.path));
	}

	// Walks the actual filesystem via the adapter, not this.app.vault.getFiles() (Obsidian's
	// in-memory file index). The index is populated by Obsidian's own file-system watcher and can
	// lag behind reality - a file written by something other than Obsidian's own file APIs (git
	// checkout, an external tool, a restored backup) may sit on disk for a while before the index
	// notices it. A diff built on a stale index can conclude a file that genuinely exists locally
	// was "deleted", and push that deletion to GitHub. Reading the real directory tree removes that
	// whole race - the diff's "local" side always matches what's actually on disk right now.
	private async listAllFilePaths(dir = ""): Promise<string[]> {
		const { files, folders } = await this.app.vault.adapter.list(dir);
		const paths = [...files];
		for (const folder of folders) {
			if (isExcluded(`${folder}/`)) continue;
			paths.push(...(await this.listAllFilePaths(folder)));
		}
		return paths;
	}

	private async computeLocalShas(): Promise<Map<string, string>> {
		const result = new Map<string, string>();
		const paths = await this.listAllFilePaths();
		for (const path of paths) {
			if (isExcluded(path)) continue;
			const bytes = await this.app.vault.adapter.readBinary(path);
			result.set(path, await gitBlobSha1(bytes));
		}
		return result;
	}

	// Three-way diff (the same logic git uses to decide whether something is a conflict): using
	// "the version both sides agreed on after the last sync" as the baseline, a change on only
	// one side can be safely auto-applied to the other; only when both sides changed, and
	// differently, is it a real conflict. Also backfills syncState for any path that's now
	// consistent on both sides (self-healing, regardless of whether it was already tracked).
	private diff(remoteTree: GitTreeEntry[], localShas: Map<string, string>): DiffResult {
		const remoteByPath = new Map(remoteTree.map((entry) => [entry.path, entry.sha]));
		const syncState = this.settings.syncState;
		const allPaths = new Set<string>([...localShas.keys(), ...remoteByPath.keys(), ...Object.keys(syncState)]);

		const toPush: PlannedChange[] = [];
		const toPull: PlannedChange[] = [];
		const conflicts: string[] = [];
		let inSyncCount = 0;
		let syncStateChanged = false;

		for (const path of allPaths) {
			// Still inside its settle window - leave it alone entirely this cycle (no push, pull,
			// or conflict, not even backfilling syncState) so a file being actively typed into is
			// never read mid-edit or overwritten by a pull decided before the edit happened. It's
			// reconsidered on the next cycle once editing has paused.
			if (this.isRecentlyModified(path)) continue;

			const local = localShas.get(path);
			const remote = remoteByPath.get(path);
			const base = syncState[path];

			if (local === remote) {
				if (local === undefined) {
					if (path in syncState) {
						delete syncState[path];
						syncStateChanged = true;
					}
				} else {
					inSyncCount++;
					if (syncState[path] !== local) {
						syncState[path] = local;
						syncStateChanged = true;
					}
				}
				continue;
			}

			const localChanged = local !== base;
			const remoteChanged = remote !== base;

			if (localChanged && !remoteChanged) {
				toPush.push({ path, action: local === undefined ? "delete" : base === undefined ? "create" : "modify" });
			} else if (remoteChanged && !localChanged) {
				toPull.push({ path, action: remote === undefined ? "delete" : base === undefined ? "create" : "modify" });
			} else {
				conflicts.push(path);
			}
		}

		if (syncStateChanged) {
			// Not awaited: this just persists the self-healing result and doesn't affect this diff's outcome
			void this.saveSettings();
		}

		toPush.sort((a, b) => a.path.localeCompare(b.path));
		toPull.sort((a, b) => a.path.localeCompare(b.path));
		conflicts.sort();
		if (toPush.length > 0 || toPull.length > 0 || conflicts.length > 0) {
			console.log(
				"[github-rest-sync] diff:",
				"toPush=",
				toPush.map((c) => `${c.action}:${c.path}`),
				"toPull=",
				toPull.map((c) => `${c.action}:${c.path}`),
				"conflicts=",
				conflicts,
			);
		}
		return { toPush, toPull, conflicts, inSyncCount };
	}

	private buildReportMarkdown(result: DiffResult): string {
		const actionLabel: Record<ChangeAction, string> = { create: "Added", modify: "Modified", delete: "Deleted" };
		const changeSection = (title: string, items: PlannedChange[]) =>
			items.length > 0
				? `## ${title} (${items.length})\n${items.map((c) => `- [${actionLabel[c.action]}] ${c.path}`).join("\n")}\n`
				: `## ${title} (0)\n(none)\n`;
		const pathSection = (title: string, items: string[]) =>
			items.length > 0
				? `## ${title} (${items.length})\n${items.map((p) => `- ${p}`).join("\n")}\n`
				: `## ${title} (0)\n(none)\n`;

		return [
			`# GitHub REST Sync Diff Report`,
			``,
			`Generated: ${new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" })}`,
			`In sync (matching content): ${result.inSyncCount} files`,
			``,
			changeSection("Changed locally only - will be pushed to GitHub", result.toPush),
			changeSection("Changed on GitHub only - will be pulled locally", result.toPull),
			pathSection("Changed on both sides, differently (needs manual review)", result.conflicts),
		].join("\n");
	}

	private isConfigured(): boolean {
		return !!parseGithubRepoUrl(this.settings.repoUrl) && !!this.settings.token;
	}

	private checkConfigured(): boolean {
		if (!this.isConfigured()) {
			new Notice("Please fill in the repository URL / token on the GitHub REST Sync settings page first");
			return false;
		}
		return true;
	}

	private async computeDiffNow(): Promise<{ remoteTree: GitTreeEntry[]; localShas: Map<string, string>; result: DiffResult }> {
		const [remoteTree, localShas] = await Promise.all([this.fetchRemoteTree(), this.computeLocalShas()]);
		const result = this.diff(remoteTree, localShas);
		return { remoteTree, localShas, result };
	}

	// After a push/pull batch is successfully applied, update syncState to "what both sides now agree on".
	private async recordSynced(changes: PlannedChange[], newShaFor: (path: string) => string | undefined) {
		for (const change of changes) {
			if (change.action === "delete") {
				delete this.settings.syncState[change.path];
			} else {
				const sha = newShaFor(change.path);
				if (sha) this.settings.syncState[change.path] = sha;
			}
		}
		await this.saveSettings();
	}

	private async writeReport(result: DiffResult) {
		const report = this.buildReportMarkdown(result);
		await this.app.vault.adapter.write(REPORT_FILE_PATH, report);
	}

	private async fetchBlobContent(sha: string): Promise<ArrayBuffer> {
		const parsed = parseGithubRepoUrl(this.settings.repoUrl);
		if (!parsed) throw new Error("Could not parse the repository URL");
		const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/blobs/${sha}`;
		const res = await requestUrl({ url, headers: this.githubHeaders(), throw: false });
		if (res.status !== 200) {
			throw new Error(`Failed to fetch file content (${res.status}): ${res.text}`);
		}
		const data = res.json as { content: string; encoding: string };
		return base64ToArrayBuffer(data.content);
	}

	private async ensureParentFolder(filePath: string): Promise<void> {
		const folderPath = filePath.split("/").slice(0, -1).join("/");
		if (!folderPath) return;
		if (!(await this.app.vault.adapter.exists(folderPath))) {
			await this.app.vault.adapter.mkdir(folderPath);
		}
	}

	private repoApiBase(): string {
		const parsed = parseGithubRepoUrl(this.settings.repoUrl);
		if (!parsed) throw new Error("Could not parse the repository URL");
		return `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
	}

	private async githubJson<T>(url: string, method: string, body?: unknown): Promise<{ status: number; json: T; text: string }> {
		const res = await requestUrl({
			url,
			method,
			headers: { ...this.githubHeaders(), "Content-Type": "application/json" },
			throw: false,
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		return { status: res.status, json: res.json as T, text: res.text };
	}

	// Reads the commit/tree sha the branch currently points to, used as the base_tree for
	// batched pushes. If the repo has no commits yet (brand new), the ref doesn't exist and this
	// returns null, falling back to the "create the first commit" path.
	private async getBranchHead(): Promise<{ commitSha: string; treeSha: string } | null> {
		const refRes = await this.githubJson<{ object: { sha: string } }>(
			`${this.repoApiBase()}/git/refs/heads/${encodeURIComponent(this.settings.branch)}`,
			"GET",
		);
		if (refRes.status === 404) return null;
		if (refRes.status !== 200) throw new Error(`Failed to get branch info (${refRes.status}): ${refRes.text}`);
		const commitSha = refRes.json.object.sha;

		const commitRes = await this.githubJson<{ tree: { sha: string } }>(`${this.repoApiBase()}/git/commits/${commitSha}`, "GET");
		if (commitRes.status !== 200) throw new Error(`Failed to get commit info (${commitRes.status}): ${commitRes.text}`);
		return { commitSha, treeSha: commitRes.json.tree.sha };
	}

	private decodeAsUtf8IfPossible(bytes: ArrayBuffer): string | null {
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			return null;
		}
	}

	// Text files embed their content directly in the tree entry (GitHub creates the blob for
	// you); only binary files (images, PDFs, etc.) need a separate call to the blobs API first
	// to get a sha. A delete is represented as sha: null - that's how the GitHub tree API says
	// "remove this path from what was inherited via base_tree".
	// Returns null to mean "skip this change for now" - either it's still inside its settle
	// window, or (a rapid create-then-delete during the same cycle) the file has already vanished
	// by the time we got here. Skipping it here, rather than letting readBinary's ENOENT abort the
	// whole batch, means the rest of the batch's genuinely-ready changes still go through; the
	// skipped one is simply reconsidered - as whatever it currently is - on the next cycle.
	private async buildTreeEntry(
		change: PlannedChange,
	): Promise<{ path: string; mode: "100644"; type: "blob"; content?: string; sha?: string | null } | null> {
		if (change.action === "delete") {
			return { path: change.path, mode: "100644", type: "blob", sha: null };
		}

		if (this.isRecentlyModified(change.path)) return null;
		if (!(await this.app.vault.adapter.exists(change.path))) return null;

		const bytes = await this.app.vault.adapter.readBinary(change.path);
		const text = this.decodeAsUtf8IfPossible(bytes);
		if (text !== null) {
			return { path: change.path, mode: "100644", type: "blob", content: text };
		}
		const blobRes = await this.githubJson<{ sha: string }>(`${this.repoApiBase()}/git/blobs`, "POST", {
			content: arrayBufferToBase64(bytes),
			encoding: "base64",
		});
		if (blobRes.status !== 201) throw new Error(`Failed to create blob (${blobRes.status}): ${blobRes.text}`);
		return { path: change.path, mode: "100644", type: "blob", sha: blobRes.json.sha };
	}

	// Packs a batch of changes (create/modify/delete) into a single commit: build a tree (on top
	// of base_tree) -> create a commit -> update the branch ref. Returns the new commit/tree sha
	// so the next batch can build on it (each batch must fast-forward, otherwise the next
	// batch's base_tree would be stale).
	private async commitBatch(
		changes: PlannedChange[],
		base: { commitSha: string; treeSha: string } | null,
		retriesLeft = 4,
	): Promise<{ head: { commitSha: string; treeSha: string } | null; applied: PlannedChange[] }> {
		const entries = [];
		const applied: PlannedChange[] = [];
		for (const change of changes) {
			const entry = await this.buildTreeEntry(change);
			if (entry === null) continue;
			entries.push(entry);
			applied.push(change);
		}

		if (applied.length === 0) {
			// Everything in this batch got skipped (still settling, or vanished before we read it) -
			// nothing to commit, leave the branch untouched.
			return { head: base, applied: [] };
		}

		const treeRes = await this.githubJson<{ sha: string }>(`${this.repoApiBase()}/git/trees`, "POST", {
			tree: entries,
			...(base ? { base_tree: base.treeSha } : {}),
		});
		if (treeRes.status !== 201) {
			// 422 here is usually "GitRPC::BadObjectState" - base_tree went stale because the branch
			// moved after we read it. Keep retrying on any 422 regardless of the exact message: a
			// retry just refetches the head and rebuilds the batch, which is harmless even if the
			// real cause turns out not to be staleness - it only costs a few extra seconds before
			// surfacing the real error below.
			if (treeRes.status === 422 && retriesLeft > 0) {
				await sleep(retryJitterMs());
				const freshBase = await this.getBranchHead();
				return this.commitBatch(changes, freshBase, retriesLeft - 1);
			}
			console.error(
				"[github-rest-sync] tree creation failed for paths:",
				changes.map((c) => c.path),
			);
			// Only claim "another device" once retries are exhausted AND the message actually
			// matches that known signature - otherwise show GitHub's real error so a genuine,
			// non-race problem (e.g. a malformed path in one of the entries above) isn't hidden
			// behind a guess.
			if (treeRes.status === 422 && /BadObjectState/i.test(treeRes.text)) {
				throw new Error(
					`Another device is syncing at the same time and this batch couldn't catch up after several retries. ` +
						`Nothing was lost - just run sync again in a moment. (${treeRes.status}: ${treeRes.text})`,
				);
			}
			throw new Error(`Failed to create tree (${treeRes.status}): ${treeRes.text}`);
		}
		const newTreeSha = treeRes.json.sha;

		const commitRes = await this.githubJson<{ sha: string }>(`${this.repoApiBase()}/git/commits`, "POST", {
			message: `GitHub REST Sync: sync ${applied.length} files`,
			tree: newTreeSha,
			...(base ? { parents: [base.commitSha] } : {}),
		});
		if (commitRes.status !== 201) throw new Error(`Failed to create commit (${commitRes.status}): ${commitRes.text}`);
		const newCommitSha = commitRes.json.sha;

		const refUrl = base
			? `${this.repoApiBase()}/git/refs/heads/${encodeURIComponent(this.settings.branch)}`
			: `${this.repoApiBase()}/git/refs`;
		const refBody = base ? { sha: newCommitSha } : { ref: `refs/heads/${this.settings.branch}`, sha: newCommitSha };
		const refRes = await this.githubJson(refUrl, base ? "PATCH" : "POST", refBody);

		if (refRes.status === 200 || refRes.status === 201) {
			return { head: { commitSha: newCommitSha, treeSha: newTreeSha }, applied };
		}

		// 422 (not a fast forward) / 409: the branch was moved by something else after we read
		// it (e.g. the same operation got triggered twice, or another device is pushing at the
		// same time). Re-read the current head and redo this batch's tree+commit against the
		// fresh base.
		if ((refRes.status === 422 || refRes.status === 409) && retriesLeft > 0) {
			await sleep(retryJitterMs());
			const freshBase = await this.getBranchHead();
			return this.commitBatch(changes, freshBase, retriesLeft - 1);
		}

		throw new Error(
			`Another device is syncing at the same time and this batch couldn't catch up after several retries. ` +
				`Nothing was lost - just run sync again in a moment. (${refRes.status}: ${refRes.text})`,
		);
	}

	private async applyPush(
		changes: PlannedChange[],
		localShas: Map<string, string>,
		onProgress: (msg: string) => void = () => {},
	): Promise<number> {
		const PUSH_BATCH_SIZE = 200;
		if (changes.length === 0) return 0;

		const batches: PlannedChange[][] = [];
		for (let i = 0; i < changes.length; i += PUSH_BATCH_SIZE) {
			batches.push(changes.slice(i, i + PUSH_BATCH_SIZE));
		}

		let head = await this.getBranchHead();
		let done = 0;
		for (let i = 0; i < batches.length; i++) {
			onProgress(`Pushing… commit ${i + 1}/${batches.length} (${done}/${changes.length} files done)`);
			const result = await this.commitBatch(batches[i], head);
			head = result.head;
			// Only the changes actually committed get recorded as synced - anything skipped (still
			// settling, or vanished before it could be read) is left out of syncState so the next
			// diff reconsiders it fresh instead of wrongly treating it as up to date.
			await this.recordSynced(result.applied, (path) => localShas.get(path));
			done += result.applied.length;
		}
		return done;
	}

	private async applyPull(
		changes: PlannedChange[],
		shaByPath: Map<string, string>,
		onProgress: (msg: string) => void = () => {},
	): Promise<{ done: number; failed: number }> {
		const PULL_BATCH_SIZE = 20; // each batch fetches in parallel, batches run sequentially, to avoid too many parallel requests at once
		if (changes.length === 0) return { done: 0, failed: 0 };

		const batches: PlannedChange[][] = [];
		for (let i = 0; i < changes.length; i += PULL_BATCH_SIZE) {
			batches.push(changes.slice(i, i + PULL_BATCH_SIZE));
		}

		let done = 0;
		let failed = 0;
		for (let i = 0; i < batches.length; i++) {
			onProgress(`Pulling… batch ${i + 1}/${batches.length} (${done}/${changes.length} files done)`);
			const batch = batches[i];
			const outcomes = await Promise.allSettled(
				batch.map(async (change): Promise<PlannedChange | null> => {
					// The diff decided this before the fetch below started; re-check right before
					// actually touching disk in case an edit landed on this exact path in between -
					// skip it for now rather than overwrite content newer than the decision was.
					if (this.isRecentlyModified(change.path)) return null;
					if (change.action === "delete") {
						console.log(`[github-rest-sync] PULL: removing local file (GitHub deleted it) - ${change.path}`);
						await this.app.vault.adapter.remove(change.path);
					} else {
						const sha = shaByPath.get(change.path);
						if (!sha) throw new Error("Could not find the matching blob sha");
						const bytes = await this.fetchBlobContent(sha);
						await this.ensureParentFolder(change.path);
						if (this.isRecentlyModified(change.path)) return null;
						console.log(
							`[github-rest-sync] PULL: writing local file from GitHub content (${change.action}) - ${change.path}`,
						);
						await this.app.vault.adapter.writeBinary(change.path, bytes);
					}
					return change;
				}),
			);

			const succeeded: PlannedChange[] = [];
			for (const outcome of outcomes) {
				if (outcome.status === "fulfilled") {
					if (outcome.value) {
						succeeded.push(outcome.value);
						done++;
					}
				} else {
					failed++;
					console.error("[multi-device-sync] pull failed", outcome.reason);
				}
			}
			// Persist the record after each batch - even if interrupted later, files that
			// already succeeded in this batch won't need to be pulled again.
			await this.recordSynced(succeeded, (path) => shaByPath.get(path));
		}
		return { done, failed };
	}

	// Diff -> push local-only changes -> pull GitHub-only changes -> refresh the report. Shared
	// by both the manual One-Click Sync and the automatic Quick Sync so the first-sync safety
	// gate below only has to live in one place.
	//
	// On a device's first-ever sync, local-only files are NOT pushed: a fresh install has no
	// baseline (syncState) to tell "genuinely new file" apart from "stale file this device still
	// has locally that was already deleted/moved on GitHub by another device" - e.g. installing
	// on an old machine that still has pre-reorg loose files. Pulling first and reporting the
	// local-only count lets the user review before anything gets uploaded; a second sync then
	// pushes normally.
	private async runSyncCycle(
		onProgress: (msg: string) => void = () => {},
	): Promise<{ pushed: number; pulled: number; pullFailed: number; conflicts: string[]; skippedPush: number }> {
		onProgress("Comparing…");
		const { remoteTree, localShas, result } = await this.computeDiffNow();

		const isFirstSync = !this.settings.firstSyncDone;
		const pushed = isFirstSync ? 0 : await this.applyPush(result.toPush, localShas, onProgress);
		const skippedPush = isFirstSync ? result.toPush.length : 0;

		const shaByPath = new Map(remoteTree.map((entry) => [entry.path, entry.sha]));
		const { done: pulled, failed: pullFailed } = await this.applyPull(result.toPull, shaByPath, onProgress);

		if (isFirstSync) {
			this.settings.firstSyncDone = true;
			await this.saveSettings();
		}

		onProgress("Updating diff report…");
		const { result: finalResult } = await this.computeDiffNow();
		await this.writeReport(finalResult);

		return { pushed, pulled, pullFailed, conflicts: finalResult.conflicts, skippedPush };
	}

	// The single public manual sync entry point: run a sync cycle, then open the resolution
	// modal if there are conflicts.
	async syncAll() {
		if (!this.checkConfigured()) return;

		let conflicts: string[] = [];
		await this.withProgress("One-Click Sync", async (modal) => {
			const { pushed, pulled, pullFailed, conflicts: c, skippedPush } = await this.runSyncCycle((msg) =>
				modal.setMessage(msg),
			);
			conflicts = c;

			const parts = [`Pushed ${pushed}`, `Pulled ${pulled}${pullFailed > 0 ? ` (${pullFailed} failed)` : ""}`];
			if (skippedPush > 0) {
				parts.push(
					`⚠️ First sync on this device: ${skippedPush} local-only file(s) were NOT uploaded - review them, then sync again to push`,
				);
			}
			if (conflicts.length > 0) {
				parts.push(`Found ${conflicts.length} conflict(s) - a resolution dialog will open`);
			}
			return `One-Click Sync complete: ${parts.join(", ")}`;
		});

		// Keep the lock held for the whole conflict-resolution window: otherwise the periodic
		// timer or a create/delete/rename event could run another sync while the modal is open
		// and change what "the GitHub version" even means before the user clicks a button.
		this.openConflictModalLocked(conflicts);
	}

	// Holds the sync lock until the modal closes (resolved or dismissed), so no other automatic
	// or manual sync can run underneath a pending conflict decision.
	private openConflictModalLocked(conflicts: string[]) {
		if (conflicts.length === 0) return;
		this.syncing = true;
		new ConflictModal(this.app, this, conflicts).open();
	}

	// Called by ConflictModal when it closes, whatever the reason (resolved or dismissed).
	releaseSyncLock() {
		this.syncing = false;
	}

	// The quiet variant used for automatic triggers: on open, on the timer, and on
	// create/delete/rename events all go through this. No progress modal, and it stays
	// completely silent when nothing changed, so it doesn't nag every 10 minutes or on every
	// file save.
	async quickSync() {
		if (!this.isConfigured()) return;
		if (this.syncing) return;

		this.syncing = true;
		let conflicts: string[] = [];
		try {
			const { pushed, pulled, pullFailed, conflicts: c, skippedPush } = await this.runSyncCycle();
			conflicts = c;

			if (pushed > 0 || pulled > 0 || pullFailed > 0 || conflicts.length > 0 || skippedPush > 0) {
				const parts = [`Pushed ${pushed}`, `Pulled ${pulled}${pullFailed > 0 ? ` (${pullFailed} failed)` : ""}`];
				if (skippedPush > 0) {
					parts.push(`⚠️ First sync: ${skippedPush} local-only file(s) not uploaded yet - run sync again to push`);
				}
				if (conflicts.length > 0) parts.push(`⚠️ ${conflicts.length} conflict(s)`);
				new Notice(`Quick Sync: ${parts.join(", ")}`);
			}
		} catch (error) {
			console.error("[multi-device-sync] quick sync failed", error);
			new Notice(`Quick Sync failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.syncing = false;
		}

		// Opened after the finally block releases the lock above, then immediately re-locks for
		// the duration of the modal - see openConflictModalLocked.
		this.openConflictModalLocked(conflicts);
	}

	private markRecentlyModified(path: string) {
		this.recentlyModified.set(path, Date.now());
	}

	private isRecentlyModified(path: string): boolean {
		const at = this.recentlyModified.get(path);
		return at !== undefined && Date.now() - at < QUICK_SYNC_DEBOUNCE_MS;
	}

	// Debounce for create/modify/delete/rename events: a burst of triggers in a short window
	// collapses into one run after the last one.
	private scheduleQuickSync(delayMs = QUICK_SYNC_DEBOUNCE_MS) {
		if (this.quickSyncDebounceTimer !== null) {
			window.clearTimeout(this.quickSyncDebounceTimer);
		}
		this.quickSyncDebounceTimer = window.setTimeout(() => {
			this.quickSyncDebounceTimer = null;
			this.quickSync();
		}, delayMs);
	}

	// Rebuilds the periodic sync timer using the configured minutes; call this again whenever
	// the setting changes to swap in the new interval.
	setupSyncInterval() {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}
		const minutes = Math.min(MAX_SYNC_INTERVAL_MINUTES, Math.max(MIN_SYNC_INTERVAL_MINUTES, this.settings.syncIntervalMinutes));
		this.syncIntervalId = window.setInterval(() => this.quickSync(), minutes * 60 * 1000);
		this.registerInterval(this.syncIntervalId);
	}

	// Resolve a single file's conflict: pick a side, and overwrite the other side with that content.
	// "Conflict" here can mean either side changed the content, OR one side deleted the file while
	// the other changed it - keep-local on a path that's since been deleted locally means "push
	// that deletion", not "read content that isn't there".
	async resolveConflict(path: string, keep: "local" | "remote") {
		if (keep === "local") {
			if (!(await this.app.vault.adapter.exists(path))) {
				await this.applyPush([{ path, action: "delete" }], new Map());
				return;
			}
			const bytes = await this.app.vault.adapter.readBinary(path);
			const sha = await gitBlobSha1(bytes);
			await this.applyPush([{ path, action: "modify" }], new Map([[path, sha]]));
		} else {
			const remoteTree = await this.fetchRemoteTree();
			const entry = remoteTree.find((e) => e.path === path);
			if (!entry) throw new Error("Couldn't find this file on GitHub - it may have been deleted");
			await this.applyPull([{ path, action: "modify" }], new Map([[path, entry.sha]]));
		}
	}

	async readLocalPreview(path: string): Promise<string> {
		if (!(await this.app.vault.adapter.exists(path))) {
			return "(This file has since been deleted locally)";
		}
		try {
			const bytes = await this.app.vault.adapter.readBinary(path);
			const text = this.decodeAsUtf8IfPossible(bytes);
			return text !== null ? text.slice(0, 300) : "(Binary file, no preview available)";
		} catch (error) {
			return `(Failed to read: ${error instanceof Error ? error.message : String(error)})`;
		}
	}

	async readRemotePreview(path: string): Promise<string> {
		try {
			const remoteTree = await this.fetchRemoteTree();
			const entry = remoteTree.find((e) => e.path === path);
			if (!entry) return "(File not found on GitHub)";
			const bytes = await this.fetchBlobContent(entry.sha);
			const text = this.decodeAsUtf8IfPossible(bytes);
			return text !== null ? text.slice(0, 300) : "(Binary file, no preview available)";
		} catch (error) {
			return `(Failed to read: ${error instanceof Error ? error.message : String(error)})`;
		}
	}
}

class ConflictModal extends Modal {
	constructor(
		app: App,
		private plugin: MultiDeviceSyncPlugin,
		private conflicts: string[],
	) {
		super(app);
	}

	async onOpen() {
		this.titleEl.setText(`${this.conflicts.length} file conflict${this.conflicts.length === 1 ? "" : "s"} to resolve`);
		this.contentEl.createEl("div", {
			text: "Both sides changed the same file. Pick one to keep - the other side will be overwritten.",
			cls: "setting-item-description",
		});

		for (const path of this.conflicts) {
			await this.renderRow(path);
		}
	}

	// Holds the sync lock for as long as this modal is open (see openConflictModalLocked), so
	// release it however the modal ends up closing - resolved, dismissed, or left open when the
	// app is closed.
	onClose() {
		this.plugin.releaseSyncLock();
	}

	private async renderRow(path: string) {
		const row = this.contentEl.createDiv();
		row.style.border = "1px solid var(--background-modifier-border)";
		row.style.borderRadius = "6px";
		row.style.padding = "8px";
		row.style.margin = "8px 0";

		row.createEl("div", { text: path }).style.fontWeight = "bold";

		const previewsEl = row.createDiv();
		previewsEl.style.display = "grid";
		previewsEl.style.gridTemplateColumns = "1fr 1fr";
		previewsEl.style.gap = "8px";
		previewsEl.style.margin = "8px 0";

		const [localPreview, remotePreview] = await Promise.all([
			this.plugin.readLocalPreview(path),
			this.plugin.readRemotePreview(path),
		]);

		for (const [label, preview] of [
			["Local", localPreview],
			["GitHub", remotePreview],
		] as const) {
			const col = previewsEl.createDiv();
			col.createEl("div", { text: label, cls: "setting-item-description" });
			const pre = col.createEl("pre", { text: preview });
			pre.style.whiteSpace = "pre-wrap";
			pre.style.fontSize = "0.8em";
			pre.style.maxHeight = "150px";
			pre.style.overflow = "auto";
			pre.style.background = "var(--background-secondary)";
			pre.style.padding = "6px";
			pre.style.borderRadius = "4px";
		}

		const buttonsEl = row.createDiv();
		buttonsEl.style.display = "flex";
		buttonsEl.style.gap = "8px";

		const statusEl = row.createDiv();

		const localBtn = buttonsEl.createEl("button", { text: "Keep Local" });
		const remoteBtn = buttonsEl.createEl("button", { text: "Keep GitHub" });

		const applyResolve = async (keep: "local" | "remote") => {
			localBtn.disabled = true;
			remoteBtn.disabled = true;
			statusEl.setText("Applying…");
			try {
				await this.plugin.resolveConflict(path, keep);
				statusEl.setText(`✅ Kept the ${keep === "local" ? "local" : "GitHub"} version`);
				statusEl.style.color = "var(--text-success)";
			} catch (error) {
				statusEl.setText(`❌ Failed: ${error instanceof Error ? error.message : String(error)}`);
				statusEl.style.color = "var(--text-error)";
				localBtn.disabled = false;
				remoteBtn.disabled = false;
			}
		};

		const resolve = async (keep: "local" | "remote") => {
			if (keep === "remote") {
				// This modal may have sat open for a while - if the local copy was edited since
				// the preview above was captured, overwriting it with GitHub's version now would
				// silently discard those newer edits. Confirm first.
				const currentLocal = await this.plugin.readLocalPreview(path);
				if (currentLocal !== localPreview) {
					localBtn.disabled = true;
					remoteBtn.disabled = true;
					statusEl.setText("");
					statusEl.style.color = "var(--text-warning)";
					statusEl.createEl("div", {
						text: "This file changed locally since this dialog opened. Keeping GitHub's version will discard those newer edits.",
					});
					const confirmBtn = statusEl.createEl("button", { text: "Discard local changes and continue" });
					const cancelBtn = statusEl.createEl("button", { text: "Cancel" });
					confirmBtn.style.marginRight = "8px";
					confirmBtn.onclick = () => applyResolve("remote");
					cancelBtn.onclick = () => {
						statusEl.empty();
						localBtn.disabled = false;
						remoteBtn.disabled = false;
					};
					return;
				}
			}
			await applyResolve(keep);
		};

		localBtn.onclick = () => resolve("local");
		remoteBtn.onclick = () => resolve("remote");
	}
}

class MultiDeviceSyncSettingTab extends PluginSettingTab {
	plugin: MultiDeviceSyncPlugin;

	constructor(app: App, plugin: MultiDeviceSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const versionEl = containerEl.createEl("div", {
			text: `GitHub REST Sync v${this.plugin.manifest.version}`,
			cls: "setting-item-description",
		});
		versionEl.style.marginBottom = "12px";

		new Setting(containerEl)
			.setName("Repository URL")
			.setDesc("Paste a GitHub URL directly, e.g. https://github.com/yaochi0362/YCObsidian")
			.addText((text) =>
				text.setValue(this.plugin.settings.repoUrl).onChange(async (value) => {
					this.plugin.settings.repoUrl = value.trim();
					await this.plugin.saveSettings();
					updateParsedDisplay();
				}),
			);

		const parsedDisplay = containerEl.createEl("div", { cls: "setting-item-description" });
		const updateParsedDisplay = () => {
			const parsed = parseGithubRepoUrl(this.plugin.settings.repoUrl);
			if (!this.plugin.settings.repoUrl) {
				parsedDisplay.setText("");
			} else if (parsed) {
				parsedDisplay.setText(`✅ Owner: ${parsed.owner}　Repo: ${parsed.repo}`);
			} else {
				parsedDisplay.setText("⚠️ Couldn't parse an owner/repo from this URL - please check the format");
			}
		};
		updateParsedDisplay();

		new Setting(containerEl)
			.setName("Branch")
			.setDesc("Defaults to main")
			.addText((text) =>
				text.setValue(this.plugin.settings.branch).onChange(async (value) => {
					this.plugin.settings.branch = value.trim() || "main";
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("GitHub Personal Access Token")
			.setDesc(
				"Fine-grained token with Contents: Read and write access to the target repo (write is required for pushing). Stored unencrypted in the local data.json, same as most similar plugins. Validated automatically once pasted.",
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(this.plugin.settings.token).onChange(async (value) => {
					this.plugin.settings.token = value.trim();
					await this.plugin.saveSettings();
					await this.plugin.validateToken(tokenStatus);
				});
			});

		const tokenStatus = containerEl.createEl("div", { cls: "setting-item-description" });
		this.plugin.validateToken(tokenStatus);

		new Setting(containerEl)
			.setName("Retest Connection")
			.setDesc("Use this to manually retest without changing the URL or token")
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					await this.plugin.validateToken(tokenStatus);
				}),
			);

		new Setting(containerEl)
			.setName("Sync interval (minutes)")
			.setDesc(
				`${MIN_SYNC_INTERVAL_MINUTES}-${MAX_SYNC_INTERVAL_MINUTES} minutes, defaults to 10. A Quick Sync is also triggered separately on open and whenever a file is created, edited, deleted, or renamed (edits wait a few seconds after you stop typing)`,
			)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = String(MIN_SYNC_INTERVAL_MINUTES);
				text.inputEl.max = String(MAX_SYNC_INTERVAL_MINUTES);
				text.setValue(String(this.plugin.settings.syncIntervalMinutes)).onChange(async (value) => {
					const parsed = Number(value);
					if (!Number.isFinite(parsed)) return;
					const clamped = Math.min(MAX_SYNC_INTERVAL_MINUTES, Math.max(MIN_SYNC_INTERVAL_MINUTES, Math.round(parsed)));
					this.plugin.settings.syncIntervalMinutes = clamped;
					await this.plugin.saveSettings();
					this.plugin.setupSyncInterval();
				});
			});
	}
}
