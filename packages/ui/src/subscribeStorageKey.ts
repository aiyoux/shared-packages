/** Listen for `localStorage` changes from other tabs. Storage events fire in
 *  the other document only — never in the writer. */
export function subscribeStorageKey(key: string, onChange: (raw: string | null) => void): () => void {
	if (typeof window === 'undefined') return () => {};
	const handler = (e: StorageEvent) => {
		if (e.storageArea !== localStorage || e.key !== key) return;
		onChange(e.newValue);
	};
	window.addEventListener('storage', handler);
	return () => window.removeEventListener('storage', handler);
}
