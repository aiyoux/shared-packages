import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createRecordStore } from '../src/services/store.ts';
import { createConnectionsService, OWNER_GONE_REASON, type ConnectionFrame, type ConnectionRecord } from '../src/services/connections.ts';
import { proxyLink, serveLink, type LinkFrame } from '../src/services/linkProxy.ts';
import type { LiveBus } from '../src/live/bus.ts';
import type { Owner } from '../src/services/owner.ts';

/** In-memory BroadcastChannel stand-in with exact sender-gone notices. */
function network<T>() {
	const clients = new Map<string, { receive: (msg: T, sender: string) => void; gone: Set<(sender: string) => void> }>();
	return (id: string): LiveBus<T> => {
		const handlers = new Set<(msg: T, sender: string) => void>();
		const gone = new Set<(sender: string) => void>();
		clients.set(id, { receive: (msg, sender) => { if (sender !== id) for (const fn of handlers) fn(structuredClone(msg), sender); }, gone });
		const post = (msg: T) => queueMicrotask(() => { for (const client of clients.values()) client.receive(msg, id); });
		return {
			broadcast: post, broadcastImmediate: post,
			onMessage(fn) { handlers.add(fn); return () => { handlers.delete(fn); }; },
			onSenderGone(fn) { gone.add(fn); return () => { gone.delete(fn); }; },
			destroy() { clients.delete(id); queueMicrotask(() => { for (const client of clients.values()) for (const fn of client.gone) fn(id); }); }
		};
	};
}
async function settle() { for (let n = 0; n < 30; n++) await new Promise<void>((resolve) => setTimeout(resolve, 0)); }

/** Owner liveness under test control: `close(ctx)` is that tab's context lock being released. */
function lockWorld() {
	const waiters = new Map<string, Array<() => void>>();
	const closed = new Set<string>();
	return {
		watch(owner: Owner, signal: AbortSignal) {
			return new Promise<void>((resolve, reject) => {
				if (owner.kind !== 'tab') return reject(new Error('tab owners only'));
				if (closed.has(owner.ctx)) return resolve();
				waiters.set(owner.ctx, [...(waiters.get(owner.ctx) ?? []), resolve]);
				signal.addEventListener('abort', () => reject(signal.reason), { once: true });
			});
		},
		close(ctx: string) { closed.add(ctx); for (const fn of waiters.get(ctx) ?? []) fn(); waiters.delete(ctx); }
	};
}

function origin() {
	const factory = new IDBFactory();
	const bus = network<ConnectionFrame>();
	const locks = lockWorld();
	const tab = (ctx: string) => createConnectionsService({
		ctx,
		store: createRecordStore<ConnectionRecord>('connections-test', factory),
		bus: bus(ctx),
		watch: locks.watch,
		self: async () => ({ kind: 'tab', ctx, label: `Tab ${ctx}` })
	});
	return { tab, locks };
}
const link = { purpose: 'hub' as const, peer: { label: 'Phone' }, route: 'p2p' as const, crypto: 'dtls' as const, apps: ['presence'] };

describe('connection registry', () => {
	it('shows a link registered in one tab in every tab, with its owner', async () => {
		const { tab } = origin();
		const a = tab('a'); const b = tab('b');
		await Promise.all([a.ready, b.ready]);
		const handle = await a.register({ ...link, id: 'link-1' });
		await settle();
		const seen = b.get(handle.id);
		assert.equal(seen?.state, 'connected');
		assert.deepEqual(seen?.owner, { kind: 'tab', ctx: 'a', label: 'Tab a' });
		await handle.update({ apps: ['presence', 'join:creative'] });
		await settle();
		assert.deepEqual(b.get('link-1')?.apps, ['presence', 'join:creative']);
	});

	it('marks a link ended when its tab closes, exactly once, and at boot when the owner is already gone', async () => {
		const { tab, locks } = origin();
		const a = tab('a'); const b = tab('b'); const c = tab('c');
		await Promise.all([a.ready, b.ready, c.ready]);
		await a.register({ ...link, id: 'link-2' });
		await settle();
		locks.close('a');
		await settle();
		assert.equal(b.get('link-2')?.state, 'ended');
		assert.equal(b.get('link-2')?.endedReason, OWNER_GONE_REASON);
		assert.equal(c.get('link-2')?.state, 'ended');
		const late = tab('d');
		await late.ready; await settle();
		assert.equal(late.get('link-2')?.state, 'ended', 'a tab that boots later sees it ended');
		await b.dismiss('link-2');
		await settle();
		assert.equal(c.list().some((row) => row.id === 'link-2'), false, 'dismissed everywhere');
	});

	it('a graceful end removes the row everywhere, and requests reach the owner from any tab', async () => {
		const { tab } = origin();
		const a = tab('a'); const b = tab('b');
		await Promise.all([a.ready, b.ready]);
		const handle = await a.register({ ...link, id: 'link-3' });
		const asked: string[] = [];
		handle.onRequest((action) => asked.push(action));
		await settle();
		b.request('link-3', 'disconnect');
		await settle();
		assert.deepEqual(asked, ['disconnect']);
		await handle.end();
		await settle();
		assert.equal(b.get('link-3'), undefined);
	});

	it('refuses to register over a live link another tab holds', async () => {
		const { tab } = origin();
		const a = tab('a'); const b = tab('b');
		await Promise.all([a.ready, b.ready]);
		await a.register({ ...link, id: 'link-4' });
		await settle();
		await assert.rejects(b.register({ ...link, id: 'link-4' }), /held by another tab/);
	});
});

describe('link proxy', () => {
	type Msg = { app: string; n: number };
	function fakeWire() {
		const handlers = new Set<(msg: Msg) => void>();
		const sent: Msg[] = [];
		return { sent, deliver(msg: Msg) { for (const fn of handlers) fn(msg); }, wire: { sendKb: (msg: Msg) => { sent.push(msg); }, onKb(fn: (msg: Msg) => void) { handlers.add(fn); return () => { handlers.delete(fn); }; } } };
	}

	it('relays only attached lanes, in order, both ways; forgets a tab that is gone', async () => {
		const bus = network<LinkFrame<Msg>>();
		const far = fakeWire();
		serveLink({ wire: far.wire, laneOf: (msg) => msg.app, bus: bus('owner') });
		const proxy = proxyLink<Msg>({ bus: bus('other'), lanes: ['presence'] });
		const got: Msg[] = [];
		proxy.onKb((msg) => got.push(msg));
		await settle();
		for (let n = 1; n <= 3; n++) far.deliver({ app: 'presence', n });
		far.deliver({ app: 'join:creative', n: 9 });
		await settle();
		assert.deepEqual(got.map((m) => m.n), [1, 2, 3], 'ordered, and the unattached lane stays with the owner');
		proxy.sendKb({ app: 'presence', n: 4 });
		await settle();
		assert.deepEqual(far.sent, [{ app: 'presence', n: 4 }]);
		proxy.close();
		await settle();
		far.deliver({ app: 'presence', n: 5 });
		await settle();
		assert.equal(got.length, 3);
	});

	it('a proxy that started before the owner attaches when the owner says hello', async () => {
		const bus = network<LinkFrame<Msg>>();
		const proxy = proxyLink<Msg>({ bus: bus('other'), lanes: ['presence'] });
		const got: Msg[] = [];
		proxy.onKb((msg) => got.push(msg));
		await settle();
		const far = fakeWire();
		serveLink({ wire: far.wire, laneOf: (msg) => msg.app, bus: bus('owner') });
		await settle();
		far.deliver({ app: 'presence', n: 1 });
		await settle();
		assert.deepEqual(got.map((m) => m.n), [1]);
	});
});
