/**
 * One SSE + one initial fetch, many listeners. No polling.
 */
export type SnapshotMux<T> = {
	subscribe(listener: (s: T) => void): () => void;
	abort(): void;
	listenerCount(): number;
};

export function createSnapshotMux<T>(opts: {
	fetchOnce: () => Promise<T>;
	openEvents: (onSnapshot: (s: T) => void) => Promise<{ abort: () => void }>;
}): SnapshotMux<T> {
	const listeners = new Set<(s: T) => void>();
	let last: T | null = null;
	let handle: { abort: () => void } | null = null;
	let starting: Promise<void> | null = null;
	let aborted = false;

	const emit = (s: T) => {
		last = s;
		for (const l of listeners) {
			try {
				l(s);
			} catch {
				/* a listener's failure is not the stream's problem */
			}
		}
	};

	const start = () => {
		if (aborted || handle || starting) return;
		starting = (async () => {
			try {
				if (listeners.size > 0 && !aborted) emit(await opts.fetchOnce());
			} catch {
				/* SSE may still deliver the first snapshot */
			}
			if (aborted || listeners.size === 0) {
				starting = null;
				return;
			}
			try {
				handle = await opts.openEvents(emit);
				if (aborted || listeners.size === 0) {
					handle.abort();
					handle = null;
				}
			} catch {
				handle = null;
			} finally {
				starting = null;
			}
		})();
	};

	return {
		subscribe(listener) {
			if (aborted) return () => {};
			listeners.add(listener);
			if (last) {
				try {
					listener(last);
				} catch {
					/* ignore */
				}
			}
			start();
			let released = false;
			return () => {
				if (released) return;
				released = true;
				listeners.delete(listener);
				if (listeners.size === 0) {
					// Drop the connection when nobody is listening; the profile
					// cache still aborts leftover streams on dispose/pagehide.
					handle?.abort();
					handle = null;
					last = null;
				}
			};
		},
		abort() {
			aborted = true;
			listeners.clear();
			handle?.abort();
			handle = null;
			starting = null;
			last = null;
		},
		listenerCount() {
			return listeners.size;
		}
	};
}
