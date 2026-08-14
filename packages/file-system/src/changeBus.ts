/**
 * Tiny listener set for live FileExplorer refresh (memory + durable VFS).
 * Monitor uses its own SSE watch; this is the in-process equivalent.
 */
export type ChangeBus = {
	subscribe(listener: () => void): () => void;
	notify(): void;
	clear(): void;
};

export function createChangeBus(): ChangeBus {
	const listeners = new Set<() => void>();
	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		notify() {
			for (const fn of [...listeners]) {
				try {
					fn();
				} catch {
					/* a stale explorer must not break writers */
				}
			}
		},
		clear() {
			listeners.clear();
		}
	};
}
