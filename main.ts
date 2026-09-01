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
		this.messageEl = this.contentEl.createEl("div", { text: "準備中…" });
		this.messageEl.style.textAlign = "center";
		this.contentEl.createEl("div", {
			text: "進行中，請勿關閉此視窗",
			cls: "setting-item-description",
		}).style.textAlign = "center";
		// 拿掉右上角關閉鈕，避免誤觸——背景其實不會被中斷，但會讓人失去進度可見度、誤以為取消了
		this.modalEl.querySelector(".modal-close-button")?.remove();
	}

	setMessage(text: string) {
		this.messageEl?.setText(text);
	}

	// 操作真正完成時呼叫這個，而不是 close()——點擊背景遮罩也會呼叫 close()，
	// 覆寫掉它讓進行中無法被關閉。
	finish() {
		this.allowClose = true;
		this.close();
	}

	close() {
		if (!this.allowClose) return;
		super.close();
	}
}

// 上次同步完成後，本機跟 GitHub 都一致的版本（path -> sha）。
// 用來分辨「這是新檔案」還是「這是被刪掉的檔案」——單看目前兩邊有沒有這個檔案是分不出來的。
type SyncState = Record<string, string>;

interface MultiDeviceSyncSettings {
	repoUrl: string;
	branch: string;
	token: string;
	syncState: SyncState;
}

const DEFAULT_SETTINGS: MultiDeviceSyncSettings = {
	repoUrl: "",
	branch: "main",
	token: "",
	syncState: {},
};

interface ParsedRepo {
	owner: string;
	repo: string;
}

// 支援 https://github.com/owner/repo、.git 結尾、尾端斜線、以及 git@github.com:owner/repo.git 格式
function parseGithubRepoUrl(url: string): ParsedRepo | null {
	const match = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
	if (!match) return null;
	return { owner: match[1], repo: match[2] };
}

// GitHub token 的已知開頭：ghp_=classic PAT、github_pat_=fine-grained PAT、
// gho_/ghu_/ghs_/ghr_=OAuth 系列。長度也粗略檢查一下，明顯太短的直接判定格式錯誤。
function looksLikeGithubToken(token: string): boolean {
	return /^(ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{10,}$/.test(token);
}

const REPORT_FILE_PATH = normalizePath("多裝置同步報告.md");

// 目前不同步的路徑前綴：裝置各自的 Obsidian 設定/暫存
const EXCLUDED_PREFIXES = [".obsidian/", ".git/", ".trash/"];
// 每次跑都會重新產生、內容一定會變的檔案：不列入比對，不然永遠會被判定成「內容不同」
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
	toPush: PlannedChange[]; // 本機動過、GitHub 沒動：套用到 GitHub
	toPull: PlannedChange[]; // GitHub 動過、本機沒動：套用到本機
	conflicts: string[]; // 兩邊都動過，而且動的不一樣：不自動處理
	inSyncCount: number;
}

function isExcluded(path: string): boolean {
	return EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)) || EXCLUDED_PATHS.includes(path);
}

function arrayBufferToBase64(bytes: ArrayBuffer): string {
	const uint8 = new Uint8Array(bytes);
	let binary = "";
	const chunkSize = 0x8000; // 避免大檔案一次 apply 太多參數炸掉呼叫堆疊
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

	// 統一入口：擋掉重疊執行（同一個 batch push 跑到一半又被點一次，
	// 兩邊各自 fast-forward branch 會互相踩到），並常駐一個進度視窗，
	// 過程中只更新視窗文字，不再連續跳好幾個 Notice。
	private async withProgress(title: string, fn: (modal: ProgressModal) => Promise<string>) {
		if (this.syncing) {
			new Notice("已經有一個同步作業在執行中，請稍候");
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
			new Notice(`${title}失敗：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			modal.finish();
			this.syncing = false;
		}
	}

	async onload() {
		console.log("[multi-device-sync] plugin loaded");
		await this.loadSettings();

		this.addSettingTab(new MultiDeviceSyncSettingTab(this.app, this));

		this.addRibbonIcon("refresh-cw", "Multi-Device Sync：一鍵同步", () => {
			this.syncAll();
		});

		this.addCommand({
			id: "multi-device-sync-ping",
			name: "Multi-Device Sync: 測試安裝是否成功",
			callback: () => {
				new Notice("Multi-Device Sync 安裝成功 ✅");
			},
		});

		this.addCommand({
			id: "multi-device-sync-all",
			name: "Multi-Device Sync: 一鍵同步（推送＋拉取）",
			callback: () => this.syncAll(),
		});

		new Notice("Multi-Device Sync 已載入");
	}

	onunload() {
		console.log("[multi-device-sync] plugin unloaded");
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// statusEl 存在就把結果寫進那個元素（顏色＋文字），供設定頁即時顯示；
	// 沒帶 statusEl（例如手動按鈕觸發）就額外補一個 Notice。
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
			setStatus("❌ Token 格式看起來不對（GitHub token 通常以 ghp_ 或 github_pat_ 開頭）", "var(--text-error)");
			return;
		}

		const parsed = parseGithubRepoUrl(this.settings.repoUrl);
		if (!parsed) {
			setStatus("⚠️ 格式正確，但 repository 網址還沒填對，無法測試連線", "var(--text-warning)");
			return;
		}

		setStatus("⏳ 驗證中…", "var(--text-muted)");
		try {
			const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
			const res = await requestUrl({ url, headers: this.githubHeaders(), throw: false });
			if (res.status === 200) {
				const data = res.json as { default_branch: string; private: boolean };
				setStatus(
					`✅ 連線成功：${parsed.owner}/${parsed.repo}（${data.private ? "private" : "public"}，預設 branch: ${data.default_branch}）`,
					"var(--text-success)",
				);
			} else if (res.status === 401) {
				setStatus("❌ Token 無效或已過期 (401)", "var(--text-error)");
			} else if (res.status === 404) {
				setStatus("❌ 找不到這個 repo，或 token 沒有存取權限 (404)", "var(--text-error)");
			} else {
				setStatus(`❌ 連線失敗 (${res.status})：${res.text}`, "var(--text-error)");
			}
		} catch (error) {
			setStatus(`❌ 連線失敗：${error instanceof Error ? error.message : String(error)}`, "var(--text-error)");
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
		if (!parsed) throw new Error("Repository 網址格式無法解析");
		const { owner, repo } = parsed;
		const { branch } = this.settings;
		const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
		const res = await requestUrl({ url, headers: this.githubHeaders(), throw: false });
		if (res.status === 409) {
			// repo 剛建立、還沒有任何 commit 時，GitHub 會回 409 "Git Repository is empty."——
			// 這不是錯誤，只是代表遠端目前是空的，繼續往下走，diff 出來會是「全部只在本機」
			return [];
		}
		if (res.status !== 200) {
			throw new Error(`GitHub API 錯誤 (${res.status}): ${res.text}`);
		}
		const data = res.json as { tree: GitTreeEntry[]; truncated: boolean };
		if (data.truncated) {
			new Notice("⚠️ 這個 repo 檔案數太多，GitHub 回傳的清單被截斷了，比對結果可能不完整");
		}
		return data.tree.filter((entry) => entry.type === "blob" && !isExcluded(entry.path));
	}

	private async computeLocalShas(): Promise<Map<string, string>> {
		const result = new Map<string, string>();
		const files = this.app.vault.getFiles();
		for (const file of files) {
			if (isExcluded(file.path)) continue;
			const bytes = await this.app.vault.adapter.readBinary(file.path);
			result.set(file.path, await gitBlobSha1(bytes));
		}
		return result;
	}

	// 三方比對（跟 git 判斷要不要衝突同一套邏輯）：拿「上次同步後雙方一致的版本」當基準，
	// 只有一邊變動就能安全地自動套用到另一邊，兩邊都變動而且變得不一樣才是真衝突。
	// 同時會把 syncState 裡「兩邊都已經一致」的項目補起來（自我修復，不管是不是本來就在裡面）。
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
			// 不 await：這只是把自我修復的結果存起來，不影響這次比對結果
			void this.saveSettings();
		}

		toPush.sort((a, b) => a.path.localeCompare(b.path));
		toPull.sort((a, b) => a.path.localeCompare(b.path));
		conflicts.sort();
		return { toPush, toPull, conflicts, inSyncCount };
	}

	private buildReportMarkdown(result: DiffResult): string {
		const actionLabel: Record<ChangeAction, string> = { create: "新增", modify: "修改", delete: "刪除" };
		const changeSection = (title: string, items: PlannedChange[]) =>
			items.length > 0
				? `## ${title}（${items.length}）\n${items.map((c) => `- [${actionLabel[c.action]}] ${c.path}`).join("\n")}\n`
				: `## ${title}（0）\n（無）\n`;
		const pathSection = (title: string, items: string[]) =>
			items.length > 0
				? `## ${title}（${items.length}）\n${items.map((p) => `- ${p}`).join("\n")}\n`
				: `## ${title}（0）\n（無）\n`;

		return [
			`# 多裝置同步差異報告`,
			``,
			`產生時間：${new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}`,
			`已同步（內容一致）：${result.inSyncCount} 個檔案`,
			``,
			changeSection("只有本機動過，會推上 GitHub", result.toPush),
			changeSection("只有 GitHub 動過，會拉回本機", result.toPull),
			pathSection("兩邊都動過，而且動的不一樣（需要人工判斷留哪一份）", result.conflicts),
			``,
			`> 這份報告只讀不寫，沒有任何檔案被實際同步或覆蓋。`,
		].join("\n");
	}

	private checkConfigured(): boolean {
		if (!parseGithubRepoUrl(this.settings.repoUrl) || !this.settings.token) {
			new Notice("請先到 Multi-Device Sync 設定頁填好 repository 網址 / token");
			return false;
		}
		return true;
	}

	private async computeDiffNow(): Promise<{ remoteTree: GitTreeEntry[]; localShas: Map<string, string>; result: DiffResult }> {
		const [remoteTree, localShas] = await Promise.all([this.fetchRemoteTree(), this.computeLocalShas()]);
		const result = this.diff(remoteTree, localShas);
		return { remoteTree, localShas, result };
	}

	// push/pull 成功套用一批變更之後，把 syncState 更新成「雙方現在的共同版本」。
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
		if (!parsed) throw new Error("Repository 網址格式無法解析");
		const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/blobs/${sha}`;
		const res = await requestUrl({ url, headers: this.githubHeaders(), throw: false });
		if (res.status !== 200) {
			throw new Error(`抓取檔案內容失敗 (${res.status}): ${res.text}`);
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
		if (!parsed) throw new Error("Repository 網址格式無法解析");
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

	// 讀取目前 branch 指向的 commit/tree sha，當作批次推送的 base_tree。
	// repo 還沒有任何 commit 時（全新 repo）ref 不存在，回傳 null，之後改用「建立第一個 commit」的流程。
	private async getBranchHead(): Promise<{ commitSha: string; treeSha: string } | null> {
		const refRes = await this.githubJson<{ object: { sha: string } }>(
			`${this.repoApiBase()}/git/refs/heads/${encodeURIComponent(this.settings.branch)}`,
			"GET",
		);
		if (refRes.status === 404) return null;
		if (refRes.status !== 200) throw new Error(`取得 branch 資訊失敗 (${refRes.status}): ${refRes.text}`);
		const commitSha = refRes.json.object.sha;

		const commitRes = await this.githubJson<{ tree: { sha: string } }>(`${this.repoApiBase()}/git/commits/${commitSha}`, "GET");
		if (commitRes.status !== 200) throw new Error(`取得 commit 資訊失敗 (${commitRes.status}): ${commitRes.text}`);
		return { commitSha, treeSha: commitRes.json.tree.sha };
	}

	private decodeAsUtf8IfPossible(bytes: ArrayBuffer): string | null {
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			return null;
		}
	}

	// 文字檔直接把內容塞進 tree entry（GitHub 會自動幫你建 blob），
	// 二進位檔（圖片、PDF 等）才需要先呼叫 blobs API 拿 sha。
	// 刪除則是 sha: null——GitHub tree API 用這個表示「從 base_tree 繼承的內容裡把這個路徑移除」。
	private async buildTreeEntry(
		change: PlannedChange,
	): Promise<{ path: string; mode: "100644"; type: "blob"; content?: string; sha?: string | null }> {
		if (change.action === "delete") {
			return { path: change.path, mode: "100644", type: "blob", sha: null };
		}

		const bytes = await this.app.vault.adapter.readBinary(change.path);
		const text = this.decodeAsUtf8IfPossible(bytes);
		if (text !== null) {
			return { path: change.path, mode: "100644", type: "blob", content: text };
		}
		const blobRes = await this.githubJson<{ sha: string }>(`${this.repoApiBase()}/git/blobs`, "POST", {
			content: arrayBufferToBase64(bytes),
			encoding: "base64",
		});
		if (blobRes.status !== 201) throw new Error(`建立 blob 失敗 (${blobRes.status}): ${blobRes.text}`);
		return { path: change.path, mode: "100644", type: "blob", sha: blobRes.json.sha };
	}

	// 把一批變更（新增/修改/刪除）打包成「一個」commit：建 tree（掛在 base_tree 上）→ 建 commit → 更新 branch ref。
	// 回傳新的 commit/tree sha，供下一批接續使用（每批之後都要 fast-forward，不然下一批的 base_tree 會過時）。
	private async commitBatch(
		changes: PlannedChange[],
		base: { commitSha: string; treeSha: string } | null,
		retriesLeft = 2,
	): Promise<{ commitSha: string; treeSha: string }> {
		const entries = [];
		for (const change of changes) {
			entries.push(await this.buildTreeEntry(change));
		}

		const treeRes = await this.githubJson<{ sha: string }>(`${this.repoApiBase()}/git/trees`, "POST", {
			tree: entries,
			...(base ? { base_tree: base.treeSha } : {}),
		});
		if (treeRes.status !== 201) throw new Error(`建立 tree 失敗 (${treeRes.status}): ${treeRes.text}`);
		const newTreeSha = treeRes.json.sha;

		const commitRes = await this.githubJson<{ sha: string }>(`${this.repoApiBase()}/git/commits`, "POST", {
			message: `Multi-Device Sync: sync ${changes.length} files`,
			tree: newTreeSha,
			...(base ? { parents: [base.commitSha] } : {}),
		});
		if (commitRes.status !== 201) throw new Error(`建立 commit 失敗 (${commitRes.status}): ${commitRes.text}`);
		const newCommitSha = commitRes.json.sha;

		const refUrl = base
			? `${this.repoApiBase()}/git/refs/heads/${encodeURIComponent(this.settings.branch)}`
			: `${this.repoApiBase()}/git/refs`;
		const refBody = base ? { sha: newCommitSha } : { ref: `refs/heads/${this.settings.branch}`, sha: newCommitSha };
		const refRes = await this.githubJson(refUrl, base ? "PATCH" : "POST", refBody);

		if (refRes.status === 200 || refRes.status === 201) {
			return { commitSha: newCommitSha, treeSha: newTreeSha };
		}

		// 422 (not a fast forward) / 409：branch 在我們讀取之後被別的東西動過
		// （例如同一個操作被重複觸發、或另一台裝置也在同時推送）。
		// 重新讀一次目前的 head，用新的 base 重做這批 tree+commit 再試一次。
		if ((refRes.status === 422 || refRes.status === 409) && retriesLeft > 0) {
			const freshBase = await this.getBranchHead();
			return this.commitBatch(changes, freshBase, retriesLeft - 1);
		}

		throw new Error(`更新 branch 失敗 (${refRes.status}): ${refRes.text}`);
	}

	private async applyPush(changes: PlannedChange[], localShas: Map<string, string>, modal: ProgressModal): Promise<number> {
		const PUSH_BATCH_SIZE = 200;
		if (changes.length === 0) return 0;

		const batches: PlannedChange[][] = [];
		for (let i = 0; i < changes.length; i += PUSH_BATCH_SIZE) {
			batches.push(changes.slice(i, i + PUSH_BATCH_SIZE));
		}

		let head = await this.getBranchHead();
		let done = 0;
		for (let i = 0; i < batches.length; i++) {
			modal.setMessage(`推送中… commit ${i + 1}/${batches.length}（已完成 ${done}/${changes.length} 個檔案）`);
			head = await this.commitBatch(batches[i], head);
			await this.recordSynced(batches[i], (path) => localShas.get(path));
			done += batches[i].length;
		}
		return done;
	}

	private async applyPull(
		changes: PlannedChange[],
		shaByPath: Map<string, string>,
		modal: ProgressModal,
	): Promise<{ done: number; failed: number }> {
		const PULL_BATCH_SIZE = 20; // 每批平行抓取，批次之間依序，避免一次開太多平行請求
		if (changes.length === 0) return { done: 0, failed: 0 };

		const batches: PlannedChange[][] = [];
		for (let i = 0; i < changes.length; i += PULL_BATCH_SIZE) {
			batches.push(changes.slice(i, i + PULL_BATCH_SIZE));
		}

		let done = 0;
		let failed = 0;
		for (let i = 0; i < batches.length; i++) {
			modal.setMessage(`拉取中… 批次 ${i + 1}/${batches.length}（已完成 ${done}/${changes.length} 個檔案）`);
			const batch = batches[i];
			const outcomes = await Promise.allSettled(
				batch.map(async (change) => {
					if (change.action === "delete") {
						await this.app.vault.adapter.remove(change.path);
					} else {
						const sha = shaByPath.get(change.path);
						if (!sha) throw new Error("找不到對應的 blob sha");
						const bytes = await this.fetchBlobContent(sha);
						await this.ensureParentFolder(change.path);
						await this.app.vault.adapter.writeBinary(change.path, bytes);
					}
					return change;
				}),
			);

			const succeeded: PlannedChange[] = [];
			for (const outcome of outcomes) {
				if (outcome.status === "fulfilled") {
					succeeded.push(outcome.value);
					done++;
				} else {
					failed++;
					console.error("[multi-device-sync] pull failed", outcome.reason);
				}
			}
			// 每批結束就存一次記錄——就算之後被中斷，這批已經成功的也不用重拉
			await this.recordSynced(succeeded, (path) => shaByPath.get(path));
		}
		return { done, failed };
	}

	// 唯一對外的同步入口：比對 → 推送本機獨有的變更 → 拉取 GitHub 獨有的變更 → 回報衝突。
	async syncAll() {
		if (!this.checkConfigured()) return;

		await this.withProgress("一鍵同步", async (modal) => {
			modal.setMessage("比對中…");
			const { remoteTree, localShas, result } = await this.computeDiffNow();

			const pushed = await this.applyPush(result.toPush, localShas, modal);

			const shaByPath = new Map(remoteTree.map((entry) => [entry.path, entry.sha]));
			const { done: pulled, failed: pullFailed } = await this.applyPull(result.toPull, shaByPath, modal);

			modal.setMessage("更新比對報告…");
			const { result: finalResult } = await this.computeDiffNow();
			await this.writeReport(finalResult);

			const parts = [`推送 ${pushed} 個`, `拉取 ${pulled} 個${pullFailed > 0 ? `（失敗 ${pullFailed}）` : ""}`];
			if (finalResult.conflicts.length > 0) {
				parts.push(`⚠️ 還有 ${finalResult.conflicts.length} 個衝突需要人工處理，詳情看「多裝置同步報告」`);
			}
			return `一鍵同步完成：${parts.join("、")}`;
		});
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

		new Setting(containerEl)
			.setName("Repository 網址")
			.setDesc("直接貼 GitHub 網址，例如 https://github.com/yaochi0362/YCObsidian")
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
				parsedDisplay.setText("⚠️ 無法從這個網址解析出 owner/repo，請確認格式");
			}
		};
		updateParsedDisplay();

		new Setting(containerEl)
			.setName("Branch")
			.setDesc("預設 main")
			.addText((text) =>
				text.setValue(this.plugin.settings.branch).onChange(async (value) => {
					this.plugin.settings.branch = value.trim() || "main";
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("GitHub Personal Access Token")
			.setDesc("Fine-grained token，Contents 權限至少要 Read-only。這裡存在本機的 data.json，未加密，跟大多數同類外掛一樣。貼上後會自動驗證")
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
			.setName("重新測試連線")
			.setDesc("網址或 token 沒變但想手動再測一次時使用")
			.addButton((button) =>
				button.setButtonText("測試").onClick(async () => {
					await this.plugin.validateToken(tokenStatus);
				}),
			);
	}
}
