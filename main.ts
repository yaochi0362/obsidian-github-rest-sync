import { Notice, Plugin } from "obsidian";

export default class MultiDeviceSyncPlugin extends Plugin {
	async onload() {
		console.log("[multi-device-sync] plugin loaded");

		this.addCommand({
			id: "multi-device-sync-ping",
			name: "Multi-Device Sync: 測試安裝是否成功",
			callback: () => {
				new Notice("Multi-Device Sync 安裝成功 ✅");
			},
		});

		new Notice("Multi-Device Sync 已載入");
	}

	onunload() {
		console.log("[multi-device-sync] plugin unloaded");
	}
}
