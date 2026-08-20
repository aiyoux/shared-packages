import { describe, it, expect } from 'vitest';
import {
	createPaneHistory,
	PANE_HISTORY_STATE_KEY,
	readPaneHistoryMarker,
	type EventTargetLike,
	type HistoryLike
} from './history.ts';

function fakeBrowser(startUrl = '/tools?s=abc') {
	const stack: { state: unknown; url: string }[] = [{ state: { sveltekit: 1 }, url: startUrl }];
	let idx = 0;
	const listeners = new Set<(event: PopStateEvent) => void>();

	const history: HistoryLike = {
		get state() {
			return stack[idx]?.state ?? null;
		},
		get length() {
			return stack.length;
		},
		replaceState(data, _unused, url) {
			stack[idx] = {
				state: data,
				url: url != null && url !== '' ? String(url) : stack[idx].url
			};
		},
		pushState(data, _unused, url) {
			stack.splice(idx + 1);
			stack.push({
				state: data,
				url: url != null && url !== '' ? String(url) : stack[idx].url
			});
			idx += 1;
		}
	};

	const target: EventTargetLike = {
		addEventListener(_type, listener) {
			listeners.add(listener);
		},
		removeEventListener(_type, listener) {
			listeners.delete(listener);
		}
	};

	function dispatch(state: unknown) {
		const event = { state } as PopStateEvent;
		for (const listener of listeners) listener(event);
	}

	function back() {
		if (idx === 0) return;
		idx -= 1;
		dispatch(stack[idx].state);
	}

	return {
		history,
		target,
		back,
		dispatch,
		get idx() {
			return idx;
		},
		stack
	};
}

describe('readPaneHistoryMarker', () => {
	it('reads a well-formed marker and rejects junk', () => {
		expect(readPaneHistoryMarker(null)).toBeNull();
		expect(readPaneHistoryMarker({ [PANE_HISTORY_STATE_KEY]: { sessionId: 'a', index: 0 } })).toEqual({
			sessionId: 'a',
			index: 0
		});
		expect(readPaneHistoryMarker({ [PANE_HISTORY_STATE_KEY]: { sessionId: 'a', index: -1 } })).toBeNull();
		expect(readPaneHistoryMarker({ sveltekit: 1 })).toBeNull();
	});
});

describe('createPaneHistory', () => {
	it('attach stamps the current entry without adding a browser slot', () => {
		const fake = fakeBrowser('/tools');
		const pops: Array<{ entry: string | undefined; index: number }> = [];
		const hist = createPaneHistory<string>({
			sessionId: 'abc',
			onPop: (entry, index) => pops.push({ entry, index }),
			history: fake.history,
			target: fake.target
		});
		hist.attach('/tools?s=abc');
		expect(fake.history.length).toBe(1);
		expect(fake.stack[0].url).toBe('/tools?s=abc');
		expect(readPaneHistoryMarker(fake.history.state)).toEqual({ sessionId: 'abc', index: 0 });
		expect(fake.history.state).toMatchObject({ sveltekit: 1 });
		expect(hist.index()).toBe(0);
		expect(hist.depth()).toBe(0);
		expect(pops).toEqual([]);
	});

	it('push adds a slot; back restores the previous payload', () => {
		const fake = fakeBrowser();
		const pops: Array<{ entry: string | undefined; index: number }> = [];
		const hist = createPaneHistory<string>({
			sessionId: 'abc',
			onPop: (entry, index) => pops.push({ entry, index }),
			history: fake.history,
			target: fake.target
		});
		hist.attach();
		hist.push('opened-files');
		expect(fake.history.length).toBe(2);
		expect(hist.index()).toBe(1);
		expect(hist.depth()).toBe(1);
		expect(readPaneHistoryMarker(fake.history.state)?.index).toBe(1);

		fake.back();
		expect(hist.index()).toBe(0);
		expect(pops).toEqual([{ entry: undefined, index: 0 }]);
		expect(readPaneHistoryMarker(fake.history.state)?.index).toBe(0);
	});

	it('ignores popstate from another session or a foreign page', () => {
		const fake = fakeBrowser();
		const pops: unknown[] = [];
		const hist = createPaneHistory<string>({
			sessionId: 'abc',
			onPop: (entry) => pops.push(entry),
			history: fake.history,
			target: fake.target
		});
		hist.attach();
		fake.dispatch({ sveltekit: 2 });
		fake.dispatch({ [PANE_HISTORY_STATE_KEY]: { sessionId: 'other', index: 0 } });
		expect(pops).toEqual([]);
		hist.detach();
		fake.dispatch({ [PANE_HISTORY_STATE_KEY]: { sessionId: 'abc', index: 0 } });
		expect(pops).toEqual([]);
	});

	it('replace overwrites the current payload without growing the stack', () => {
		const fake = fakeBrowser();
		const pops: Array<string | undefined> = [];
		const hist = createPaneHistory<string>({
			sessionId: 'abc',
			onPop: (entry) => pops.push(entry),
			history: fake.history,
			target: fake.target
		});
		hist.attach();
		hist.push('a');
		hist.replace('b');
		expect(fake.history.length).toBe(2);
		expect(hist.depth()).toBe(1);
		fake.back();
		expect(pops).toEqual([undefined]);
		hist.push('c');
		expect(hist.depth()).toBe(1);
		fake.back();
		expect(pops).toEqual([undefined, undefined]);
	});
});

