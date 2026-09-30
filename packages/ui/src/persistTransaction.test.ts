import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Store = typeof import('./persistKv');
let stores: Store[] = [];

async function tab(): Promise<Store> {
	vi.resetModules();
	const store = await import('./persistKv');
	stores.push(store);
	await store.persistReady();
	return store;
}

describe('strict persistTransaction', () => {
	beforeEach(() => {
		vi.stubGlobal('indexedDB', new IDBFactory());
		vi.stubGlobal('localStorage', undefined);
		// Keep each tab's cache stale deliberately: transactions must use IDB.
		vi.stubGlobal('BroadcastChannel', undefined);
	});
	afterEach(() => {
		for (const store of stores) store.__resetPersistKvForTests();
		stores = [];
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('serializes concurrent tab updates from authoritative values', async () => {
		const a = await tab();
		const b = await tab();
		await Promise.all([a, b].map((store, index) => store.persistTransaction(['turns'], (values) =>
			new Map([['turns', [...(values.get('turns') as number[] ?? []), index]]])
		)));
		const fresh = await tab();
		expect(fresh.persistGet('turns')).toEqual([0, 1]);
	});

	it('orders transactions with queued legacy setters without poisoning the queue', async () => {
		const store = await tab();
		const increment = () => store.persistTransaction(['count'], (values) => new Map([['count', Number(values.get('count')) + 1]]));
		store.persistSet('count', 1);
		const first = increment();
		store.persistSet('count', 10);
		const second = increment();
		await Promise.all([first, second]);
		await store.persistFlush();
		expect((await tab()).persistGet('count')).toBe(11);
	});

	it('rejects an authoritative deletion even when a tab still has the old cached row', async () => {
		const a = await tab();
		await a.persistTransaction([], () => new Map([['session', { id: 'saved' }]]));
		const b = await tab();
		expect(b.persistGet('session')).toEqual({ id: 'saved' });
		await a.persistTransaction([], () => new Map([['session', undefined]]));
		await expect(b.persistTransaction(['session'], (values) => {
			if (!values.get('session')) throw new Error('Session deleted');
			return new Map([['reply', 'text']]);
		})).rejects.toThrow('Session deleted');
		const fresh = await tab();
		expect(fresh.persistGet('session')).toBeUndefined();
		expect(fresh.persistGet('reply')).toBeUndefined();
	});

	it('rolls back all keys and publishes no cache values when storage aborts', async () => {
		const store = await tab();
		await store.persistTransaction([], () => new Map([['existing', 'before']]));
		const put = IDBObjectStore.prototype.put;
		const aborting = new WeakSet<IDBTransaction>();
		const abort = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (...args) {
			const request = put.apply(this, args);
			if (!aborting.has(this.transaction)) {
				aborting.add(this.transaction);
				queueMicrotask(() => this.transaction.abort());
			}
			return request;
		});
		await expect(store.persistTransaction(['existing'], () => new Map([
			['existing', 'after'], ['extra', 'must roll back']
		]))).rejects.toThrow();
		expect(store.persistGet('existing')).toBe('before');
		expect(store.persistGet('extra')).toBeUndefined();
		abort.mockRestore();
		store.persistSet('recovery', 'legacy still works');
		await store.persistFlush();
		const fresh = await tab();
		expect(fresh.persistGet('existing')).toBe('before');
		expect(fresh.persistGet('extra')).toBeUndefined();
		expect(fresh.persistGet('recovery')).toBe('legacy still works');
	});

	it('rejects unavailable durable storage instead of accepting a cache-only save', async () => {
		vi.stubGlobal('indexedDB', undefined);
		const store = await tab();
		await expect(store.persistTransaction([], () => new Map([['reply', 'text']]))).rejects.toThrow('Durable storage is unavailable');
		expect(store.persistGet('reply')).toBeUndefined();
	});
});
