import { Notice, Plugin } from "obsidian";

export default class YcVaultSyncPlugin extends Plugin {
	async onload() {
		console.log("[yc-vault-sync] plugin loaded");

		this.addCommand({
			id: "yc-vault-sync-ping",
			name: "YC Vault Sync: 測試安裝是否成功",
			callback: () => {
				new Notice("YC Vault Sync 安裝成功 ✅");
			},
		});

		new Notice("YC Vault Sync 已載入");
	}

	onunload() {
		console.log("[yc-vault-sync] plugin unloaded");
	}
}
