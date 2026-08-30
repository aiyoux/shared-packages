import type { ClipboardItem } from './types.js';

export const CLIPBOARD_SYNC_STORAGE_KEY = 'sp_clipboard_sync_system';
const MAX_CLIPBOARD_HISTORY = 20;

export class ClipboardStore {
	items = $state<ClipboardItem[]>([]);
	syncWithSystem = $state<boolean>(false);
	isReadingSystem = $state<boolean>(false);
	systemReadError = $state<string | null>(null);

	constructor() {
		if (typeof window !== 'undefined') {
			try {
				const saved = localStorage.getItem(CLIPBOARD_SYNC_STORAGE_KEY);
				if (saved !== null) {
					this.syncWithSystem = saved === 'true';
				}
			} catch {
				/* storage access best-effort */
			}
		}
	}

	get current(): ClipboardItem | null {
		return this.items[0] ?? null;
	}

	setSyncWithSystem(enabled: boolean) {
		this.syncWithSystem = enabled;
		if (typeof window !== 'undefined') {
			try {
				localStorage.setItem(CLIPBOARD_SYNC_STORAGE_KEY, String(enabled));
			} catch {
				/* storage access best-effort */
			}
			if (enabled) {
				void this.readFromSystem();
			}
		}
	}

	async copy<T = unknown>(
		type: string,
		label: string,
		data: T,
		textPreview?: string
	): Promise<ClipboardItem<T>> {
		const item: ClipboardItem<T> = {
			id: 'clip_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
			type,
			label,
			data,
			textPreview: textPreview || (typeof data === 'string' ? data.slice(0, 150) : undefined),
			createdAt: Date.now()
		};

		this.items = [item as ClipboardItem, ...this.items.slice(0, MAX_CLIPBOARD_HISTORY - 1)];

		if (this.syncWithSystem && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
			try {
				let textToWrite = '';
				if (typeof data === 'string') {
					textToWrite = data;
				} else if (textPreview) {
					textToWrite = textPreview;
				} else {
					textToWrite = JSON.stringify({ type, label, data });
				}
				await navigator.clipboard.writeText(textToWrite);
			} catch {
				/* system clipboard write best effort */
			}
		}

		return item;
	}

	async paste<T = unknown>(expectedType?: string): Promise<T | null> {
		if (this.syncWithSystem && typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
			try {
				const sysText = await navigator.clipboard.readText();
				if (sysText) {
					try {
						const parsed = JSON.parse(sysText);
						if (parsed && typeof parsed === 'object' && parsed.type) {
							if (!expectedType || parsed.type === expectedType) {
								return (parsed.data ?? parsed) as T;
							}
						}
					} catch {
						if (!expectedType || expectedType === 'text/plain' || expectedType === 'text') {
							return sysText as unknown as T;
						}
					}
				}
			} catch {
				/* fallback to internal */
			}
		}

		if (expectedType) {
			const found = this.items.find((i) => i.type === expectedType);
			return (found?.data as T) ?? null;
		}
		return (this.current?.data as T) ?? null;
	}

	peek<T = unknown>(expectedType?: string): T | null {
		if (expectedType) {
			const found = this.items.find((i) => i.type === expectedType);
			return (found?.data as T) ?? null;
		}
		return (this.current?.data as T) ?? null;
	}

	async readFromSystem(): Promise<void> {
		if (!this.syncWithSystem || typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
			return;
		}
		this.isReadingSystem = true;
		this.systemReadError = null;
		try {
			const text = await navigator.clipboard.readText();
			if (text && (!this.current || this.current.textPreview !== text)) {
				let type = 'text/plain';
				let label = `System Text (${text.length} chars)`;
				let data: unknown = text;
				try {
					const parsed = JSON.parse(text);
					if (parsed && typeof parsed === 'object' && parsed.type && parsed.data) {
						type = parsed.type;
						label = parsed.label || 'System Item';
						data = parsed.data;
					}
				} catch {
					/* plain text */
				}
				const item: ClipboardItem = {
					id: 'sys_' + Date.now().toString(36),
					type,
					label,
					data,
					textPreview: typeof data === 'string' ? data.slice(0, 150) : `${type} from system`,
					createdAt: Date.now()
				};
				this.items = [item, ...this.items.filter((i) => i.textPreview !== text).slice(0, MAX_CLIPBOARD_HISTORY - 1)];
			}
		} catch (err) {
			this.systemReadError = err instanceof Error ? err.message : 'Could not read system clipboard';
		} finally {
			this.isReadingSystem = false;
		}
	}

	async copyToSystem(item: ClipboardItem): Promise<boolean> {
		if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
		try {
			let text = '';
			if (typeof item.data === 'string') {
				text = item.data;
			} else if (item.textPreview) {
				text = item.textPreview;
			} else {
				text = JSON.stringify({ type: item.type, label: item.label, data: item.data });
			}
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			return false;
		}
	}

	removeItem(id: string) {
		this.items = this.items.filter((i) => i.id !== id);
	}

	clear() {
		this.items = [];
	}
}

export const appClipboard = new ClipboardStore();
