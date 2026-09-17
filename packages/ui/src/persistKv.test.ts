import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	__resetPersistKvForTests,
	persistFlush,
	persistGet,
	persistGetItem,
	persistKv,
	persistReady,
	persistRemove,
	persistSet
} from './persistKv.ts';

function installMemoryLocalStorage() {
	const map = new Map<string, string>();
	const ls = {
		getItem(key: string) {
			return map.has(key) ? map.get(key)! : null;
		},
		setItem(key: string, value: string) {
			map.set(key, String(value));
		},
		removeItem(key: string) {
			map.delete(key);
		},
		clear() {
			map.clear();
		},
		key(i: number) {
			return [...map.keys()][i] ?? null;
		},
		get length() {
			return map.size;
		}
	};
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: ls
	});
}

describe('persistKv', () => {
	beforeEach(() => {
		installMemoryLocalStorage();
		__resetPersistKvForTests();
	});

	afterEach(() => {
		__resetPersistKvForTests();
		try {
			localStorage.clear();
		} catch {
			/* node */
		}
	});

	it('round-trips a string and an object in the cache', async () => {
		await persistReady();
		persistKv.setItem('pref', 'dark');
		persistSet('draft', { n: 3 });
		expect(persistGetItem('pref')).toBe('dark');
		expect(persistGet('draft')).toEqual({ n: 3 });
		persistRemove('pref');
		expect(persistGetItem('pref')).toBeNull();
	});

	it('migrates leftover localStorage keys except the FOUC theme', async () => {
		localStorage.setItem('scratchpad-color-scheme', 'light');
		localStorage.setItem('text:last-open-node', 'node-1');
		localStorage.setItem('live-doc:storage', 'ping');
		await persistReady();
		expect(persistGetItem('text:last-open-node')).toBe('node-1');
		expect(localStorage.getItem('text:last-open-node')).toBeNull();
		expect(localStorage.getItem('scratchpad-color-scheme')).toBe('light');
		expect(localStorage.getItem('live-doc:storage')).toBe('ping');
	});

	it('falls back to localStorage before a key is cached', () => {
		localStorage.setItem('seed', 'from-ls');
		expect(persistGetItem('seed')).toBe('from-ls');
	});

	it('flush resolves after a queued write', async () => {
		await persistReady();
		persistSet('blob', new Uint8Array([1, 2, 3]));
		await persistFlush();
		expect(persistGet('blob')).toEqual(new Uint8Array([1, 2, 3]));
	});
});
