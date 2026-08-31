import { App, Notice, Plugin, PluginSettingTab, Setting, requestUrl, normalizePath } from "obsidian";

interface MultiDeviceSyncSettings {
	repoUrl: string;
	branch: string;
	token: string;
}

const DEFAULT_SETTINGS: MultiDeviceSyncSettings = {
	repoUrl: "",
	branch: "main",
	token: "",
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

// 目前不同步的路徑前綴：裝置各自的 Obsidian 設定/暫存
const EXCLUDED_PREFIXES = [".obsidian/", ".git/", ".trash/"];

interface GitTreeEntry {
	path: string;
	type: string;
	sha: string;
	size?: number;
}

interface DiffResult {
	onlyLocal: string[];
	onlyRemote: string[];
	differs: string[];
	inSyncCount: number;
}

function isExcluded(path: string): boolean {
	return EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix));
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

	async onload() {
		console.log("[multi-device-sync] plugin loaded");
		await this.loadSettings();

		this.addSettingTab(new MultiDeviceSyncSettingTab(this.app, this));

		this.addCommand({
			id: "multi-device-sync-ping",
			name: "Multi-Device Sync: 測試安裝是否成功",
			callback: () => {
				new Notice("Multi-Device Sync 安裝成功 ✅");
			},
		});

		this.addCommand({
			id: "multi-device-sync-dry-run",
			name: "Multi-Device Sync: 比對雲端與本機差異（不會寫入任何檔案）",
			callback: () => this.runDryRun(),
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

	private diff(remoteTree: GitTreeEntry[], localShas: Map<string, string>): DiffResult {
		const remoteByPath = new Map(remoteTree.map((entry) => [entry.path, entry.sha]));
		const onlyLocal: string[] = [];
		const onlyRemote: string[] = [];
		const differs: string[] = [];
		let inSyncCount = 0;

		for (const [path, localSha] of localShas) {
			const remoteSha = remoteByPath.get(path);
			if (remoteSha === undefined) {
				onlyLocal.push(path);
			} else if (remoteSha !== localSha) {
				differs.push(path);
			} else {
				inSyncCount++;
			}
			remoteByPath.delete(path);
		}
		for (const path of remoteByPath.keys()) {
			onlyRemote.push(path);
		}

		onlyLocal.sort();
		onlyRemote.sort();
		differs.sort();
		return { onlyLocal, onlyRemote, differs, inSyncCount };
	}

	private buildReportMarkdown(result: DiffResult): string {
		const section = (title: string, items: string[]) =>
			items.length > 0
				? `## ${title}（${items.length}）\n${items.map((p) => `- ${p}`).join("\n")}\n`
				: `## ${title}（0）\n（無）\n`;

		return [
			`# 多裝置同步差異報告`,
			``,
			`產生時間：${new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}`,
			`已同步（內容一致）：${result.inSyncCount} 個檔案`,
			``,
			section("只存在本機，GitHub 上沒有（需要推上去）", result.onlyLocal),
			section("只存在 GitHub，本機沒有（需要拉下來）", result.onlyRemote),
			section("兩邊都有，但內容不同（需要人工判斷留哪一份）", result.differs),
			``,
			`> 這份報告只讀不寫，沒有任何檔案被實際同步或覆蓋。`,
		].join("\n");
	}

	async runDryRun() {
		if (!parseGithubRepoUrl(this.settings.repoUrl) || !this.settings.token) {
			new Notice("請先到 Multi-Device Sync 設定頁填好 repository 網址 / token");
			return;
		}

		new Notice("開始比對，請稍候…");
		try {
			const [remoteTree, localShas] = await Promise.all([this.fetchRemoteTree(), this.computeLocalShas()]);
			const result = this.diff(remoteTree, localShas);
			const report = this.buildReportMarkdown(result);

			const reportPath = normalizePath("多裝置同步報告.md");
			await this.app.vault.adapter.write(reportPath, report);

			new Notice(
				`比對完成：一致 ${result.inSyncCount}、只在本機 ${result.onlyLocal.length}、只在雲端 ${result.onlyRemote.length}、內容不同 ${result.differs.length}。詳情請看「多裝置同步報告」筆記`,
			);
		} catch (error) {
			console.error("[multi-device-sync] dry run failed", error);
			new Notice(`比對失敗：${error instanceof Error ? error.message : String(error)}`);
		}
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
			.setDesc("Fine-grained token，Contents 權限至少要 Read-only。這裡存在本機的 data.json，未加密，跟大多數同類外掛一樣")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(this.plugin.settings.token).onChange(async (value) => {
					this.plugin.settings.token = value.trim();
					await this.plugin.saveSettings();
				});
			});
	}
}
