/** Listen for persisted-key changes from other tabs.
 *
 *  Color-scheme still uses `localStorage` (FOUC). Everything else is
 *  `persistKv` over BroadcastChannel `scratch-persist-kv`. */
export function subscribeStorageKey(key: string, onChange: (raw: string | null) => void): () => void {
	if (typeof window === 'undefined') return () => {};
	const handler = (e: StorageEvent) => {
		if (e.storageArea !== localStorage || e.key !== key) return;
		onChange(e.newValue);
	};
	window.addEventListener('storage', handler);
	let ch: BroadcastChannel | null = null;
	const onPersist = (e: MessageEvent) => {
		const data = e.data as { key?: string; value?: unknown; deleted?: boolean } | null;
		if (!data || data.key !== key) return;
		if (data.deleted) {
			onChange(null);
			return;
		}
		onChange(typeof data.value === 'string' ? data.value : data.value == null ? null : JSON.stringify(data.value));
	};
	try {
		ch = new BroadcastChannel('scratch-persist-kv');
		ch.addEventListener('message', onPersist);
	} catch {
		ch = null;
	}
	return () => {
		window.removeEventListener('storage', handler);
		if (ch) {
			ch.removeEventListener('message', onPersist);
			ch.close();
		}
	};
}
