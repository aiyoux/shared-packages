/**
 * In-workspace back stack bound to the browser Back button.
 *
 * Layout storage is keyed by session id and the URL stays on `/tools?s=…`
 * while the user splits panes and opens tools. Without our own history
 * slots, Back leaves the workspace instead of undoing those steps.
 *
 * `attach()` stamps the *current* history entry as index 0 (replace, not
 * push). Callers `push()` later to add slots; until then Back still leaves
 * the page because there is nothing of ours to pop.
 */

export const PANE_HISTORY_STATE_KEY = 'spPaneHistory';

export type PaneHistoryMarker = {
	sessionId: string;
	index: number;
};

export type HistoryLike = {
	state: unknown;
	length: number;
	pushState(data: unknown, unused: string, url?: string | URL | null): void;
	replaceState(data: unknown, unused: string, url?: string | URL | null): void;
};

export type EventTargetLike = {
	addEventListener(type: 'popstate', listener: (event: PopStateEvent) => void): void;
	removeEventListener(type: 'popstate', listener: (event: PopStateEvent) => void): void;
};

export type PaneHistory<T> = {
	/** Current slot. 0 is the attached baseline (no pushed payload). */
	index(): number;
	/** Number of `push()`ed payloads (not counting the baseline). */
	depth(): number;
	/** Stamp this session on the current history entry. Does not add a slot. */
	attach(url?: string | URL | null): void;
	detach(): void;
	/** Record a payload and add a browser history slot (same URL by default). */
	push(data: T, url?: string | URL | null): void;
	/** Overwrite the payload at the current slot without adding a browser slot. */
	replace(data: T, url?: string | URL | null): void;
};

export function readPaneHistoryMarker(state: unknown): PaneHistoryMarker | null {
	if (!state || typeof state !== 'object') return null;
	const raw = (state as Record<string, unknown>)[PANE_HISTORY_STATE_KEY];
	if (!raw || typeof raw !== 'object') return null;
	const rec = raw as Record<string, unknown>;
	if (typeof rec.sessionId !== 'string' || !rec.sessionId) return null;
	if (typeof rec.index !== 'number' || !Number.isInteger(rec.index) || rec.index < 0) {
		return null;
	}
	return { sessionId: rec.sessionId, index: rec.index };
}

export function createPaneHistory<T>(opts: {
	sessionId: string;
	onPop: (entry: T | undefined, index: number) => void;
	history?: HistoryLike | null;
	target?: EventTargetLike | null;
}): PaneHistory<T> {
	const sessionId = opts.sessionId;
	const entries: Array<T | undefined> = [undefined];
	let cursor = 0;
	let listening = false;

	const history = (): HistoryLike | null => {
		if (opts.history) return opts.history;
		if (typeof globalThis.history === 'undefined') return null;
		return globalThis.history;
	};

	const target = (): EventTargetLike | null => {
		if (opts.target) return opts.target;
		if (typeof globalThis.window === 'undefined') return null;
		return globalThis.window;
	};

	function mergeState(index: number): object {
		const hist = history();
		const prev = hist?.state;
		const base =
			prev && typeof prev === 'object' && !Array.isArray(prev)
				? { ...(prev as Record<string, unknown>) }
				: {};
		base[PANE_HISTORY_STATE_KEY] = { sessionId, index } satisfies PaneHistoryMarker;
		return base;
	}

	function write(mode: 'push' | 'replace', index: number, url?: string | URL | null) {
		const hist = history();
		if (!hist) return;
		const state = mergeState(index);
		const hasUrl = url != null && url !== '';
		if (mode === 'push') {
			if (hasUrl) hist.pushState(state, '', url);
			else hist.pushState(state, '');
		} else if (hasUrl) hist.replaceState(state, '', url);
		else hist.replaceState(state, '');
		listen();
	}

	function onPopState(event: PopStateEvent) {
		const marker = readPaneHistoryMarker(event.state);
		if (!marker || marker.sessionId !== sessionId) return;
		cursor = Math.min(marker.index, Math.max(0, entries.length - 1));
		opts.onPop(entries[cursor], cursor);
	}

	function listen() {
		if (listening) return;
		const t = target();
		if (!t) return;
		t.addEventListener('popstate', onPopState);
		listening = true;
	}

	return {
		index: () => cursor,
		depth: () => Math.max(0, entries.length - 1),
		attach(url) {
			if (!history()) return;
			cursor = 0;
			write('replace', 0, url);
		},
		detach() {
			if (!listening) return;
			target()?.removeEventListener('popstate', onPopState);
			listening = false;
		},
		push(data, url) {
			if (!history()) return;
			cursor += 1;
			entries.length = cursor;
			entries[cursor] = data;
			write('push', cursor, url);
		},
		replace(data, url) {
			if (!history()) return;
			entries[cursor] = data;
			write('replace', cursor, url);
		}
	};
}
