import { describe, expect, it } from 'vitest';
import { createDocSession, type DocSession, type DocSessionFrame } from './docSession.js';
import type { Election } from './leadership.js';
import type { RelayMember } from './relay.js';
import { peerMember, type EngineTab } from './sessionEngine.js';

/**
 * An in-memory browser: a bus and a lock per room, and the subordinate claim.
 * Delivery is async (a microtask), as BroadcastChannel is.
 */
type Doc = { items: string[] };
type Op = { add: string } | { remove: string };
type Frame = DocSessionFrame<Doc, Op>;

const reduce = (doc: Doc, op: Op): Doc =>
	'add' in op ? { items: [...doc.items, op.add] } : { items: doc.items.filter((i) => i !== op.remove) };

async function settle(): Promise<void> {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

function browser() {
	const buses = new Map<string, Set<{ id: string; deliver: (f: Frame) => void }>>();
	const locks = new Map<string, FakeElection[]>();
	const gateways = new Map<string, Set<string>>();
	const claimWatchers = new Map<string, Set<() => void>>();

	class FakeElection implements Election {
		decided = false;
		isLeader = false;
		private fns = new Set<() => void>();
		constructor(private readonly name: string) {
			const queue = locks.get(name) ?? [];
			locks.set(name, queue);
			queue.push(this);
			queueMicrotask(() => this.recheck());
		}
		recheck() {
			const queue = locks.get(this.name) ?? [];
			const lead = queue[0] === this;
			if (this.decided && lead === this.isLeader) return;
			this.decided = true;
			this.isLeader = lead;
			for (const fn of [...this.fns]) fn();
		}
		onChange(fn: () => void) {
			this.fns.add(fn);
			return () => this.fns.delete(fn);
		}
		yieldLeadership() {}
		destroy() {
			const queue = (locks.get(this.name) ?? []).filter((e) => e !== this);
			locks.set(this.name, queue);
			this.fns.clear();
			queueMicrotask(() => queue.forEach((e) => e.recheck()));
		}
	}

	const tab: EngineTab<Frame> = {
		member(room, clientId): RelayMember<Frame> {
			const set = buses.get(room) ?? new Set();
			buses.set(room, set);
			const handlers = new Set<(f: Frame) => void>();
			const self = { id: clientId, deliver: (f: Frame) => handlers.forEach((h) => h(f)) };
			set.add(self);
			return {
				id: 'tab',
				send(frame) {
					const copy = structuredClone(frame);
					for (const other of set) if (other !== self) queueMicrotask(() => other.deliver(copy));
				},
				subscribe(h) {
					handlers.add(h);
					return () => handlers.delete(h);
				},
				close() {
					set.delete(self);
				}
			};
		},
		election: (room) => new FakeElection(`seq:${room}`),
		persist: (room) => new FakeElection(`persist:${room}`),
		claimChannel: (room) => `claim:${room}`,
		claim: {
			announce(channel, clientId) {
				const set = gateways.get(channel) ?? new Set();
				gateways.set(channel, set);
				set.add(clientId);
				claimWatchers.get(channel)?.forEach((fn) => queueMicrotask(fn));
				return () => {
					set.delete(clientId);
					claimWatchers.get(channel)?.forEach((fn) => queueMicrotask(fn));
				};
			},
			watch(channel, clientId, onChange) {
				const report = () => {
					const others = [...(gateways.get(channel) ?? [])].filter((id) => id !== clientId);
					onChange(others.length > 0);
				};
				const set = claimWatchers.get(channel) ?? new Set();
				claimWatchers.set(channel, set);
				set.add(report);
				report();
				return () => set.delete(report);
			}
		}
	};
	return { tab };
}

/** A WebRTC link: two ends, JSON on the wire. */
function link() {
	const ends = [new Set<(f: Frame) => void>(), new Set<(f: Frame) => void>()];
	const end = (me: 0 | 1) => ({
		send(frame: Frame) {
			const wire = JSON.parse(JSON.stringify(frame)) as Frame;
			queueMicrotask(() => ends[1 - me]!.forEach((h) => h(wire)));
		},
		subscribe(h: (f: Frame) => void) {
			ends[me]!.add(h);
			return () => ends[me]!.delete(h);
		},
		close() {
			ends[me]!.clear();
		}
	});
	return { a: end(0), b: end(1) };
}

function open(tab: EngineTab<Frame> | null, room: string, initial: Doc = { items: [] }): DocSession<Doc, Op> {
	return createDocSession<Doc, Op>({ room, tab, initial, reduce });
}

const items = (s: DocSession<Doc, Op>) => [...s.doc.items].sort();

describe('session engine: tabs', () => {
	it('two tabs of one room elect one sequencer and converge both ways', async () => {
		const { tab } = browser();
		const a = open(tab, 'file-1', { items: ['x'] });
		await settle();
		const b = open(tab, 'file-1');
		await settle();
		expect([a.role, b.role].sort()).toEqual(['follower', 'leader']);
		expect(items(b)).toEqual(['x']);

		await a.commit({ add: 'from-a' });
		await b.commit({ add: 'from-b' });
		await settle();
		expect(items(a)).toEqual(['from-a', 'from-b', 'x']);
		expect(items(b)).toEqual(items(a));
		expect([a.persistOwner, b.persistOwner].filter(Boolean)).toHaveLength(1);
	});

	it('the follower takes over when the leader goes, with the document it has', async () => {
		const { tab } = browser();
		const a = open(tab, 'r', { items: ['x'] });
		await settle();
		const b = open(tab, 'r');
		await settle();
		await a.commit({ add: 'y' });
		await settle();
		a.destroy();
		await settle();
		expect(b.role).toBe('leader');
		await b.commit({ add: 'z' });
		await settle();
		expect(items(b)).toEqual(['x', 'y', 'z']);
	});

	it('edits made before the lock answers are kept', async () => {
		const { tab } = browser();
		const a = open(tab, 'r');
		await a.commit({ add: 'early' });
		await settle();
		expect(items(a)).toEqual(['early']);
	});

	it('moves to another room (the first save) and keeps syncing there', async () => {
		const { tab } = browser();
		const a = open(tab, 'session:s1', { items: ['x'] });
		await settle();
		const b = open(tab, 'session:s1');
		await settle();
		expect(items(b)).toEqual(['x']);
		a.setRoom('file-9');
		b.setRoom('file-9');
		await settle();
		expect([a.role, b.role].sort()).toEqual(['follower', 'leader']);
		await b.commit({ add: 'after-save' });
		await settle();
		expect(items(a)).toEqual(['after-save', 'x']);
	});

	it('a save notice reaches tabs of the same room only', async () => {
		const { tab } = browser();
		const saves: string[] = [];
		const mk = (room: string, name: string) =>
			createDocSession<Doc, Op>({
				room,
				tab,
				initial: { items: [] },
				reduce,
				onSaved: (info) => saves.push(`${name}:${info.generation}:${info.local}`)
			});
		const a = mk('f', 'a');
		await settle();
		mk('f', 'b');
		mk('g', 'c');
		await settle();
		a.announceSaved(7);
		await settle();
		expect(saves.sort()).toEqual(['a:7:true', 'b:7:false']);
	});
});

describe('session engine: peers', () => {
	/**
	 * Device A (host) with tabs A1 (holds the call) and A2; device B (guest)
	 * with B1 (holds the call) and B2. A2 is opened first, so it holds A's lock:
	 * the call must still leave A with one sequencer, A1.
	 */
	async function call() {
		const devA = browser();
		const devB = browser();
		const a2 = open(devA.tab, 'file-a', { items: ['host'] });
		await settle();
		const a1 = open(devA.tab, 'file-a');
		const b1 = open(devB.tab, 'file-b', { items: ['guest-own'] });
		await settle();
		const b2 = open(devB.tab, 'file-b');
		await settle();
		const wire = link();
		a1.setPeer('invite', { role: 'sequencer', member: peerMember('invite', wire.a) });
		b1.setPeer('invite', { role: 'replica', member: peerMember('invite', wire.b) });
		await settle();
		return { a1, a2, b1, b2, wire };
	}

	it('one sequencer across both devices, and every tab gets the host document', async () => {
		const { a1, a2, b1, b2 } = await call();
		expect([a1.role, a2.role, b1.role, b2.role]).toEqual(['leader', 'follower', 'follower', 'follower']);
		for (const s of [a1, a2, b1, b2]) expect(items(s)).toEqual(['host']);
	});

	it('an edit from any tab of either device reaches all four', async () => {
		const { a1, a2, b1, b2 } = await call();
		await a1.commit({ add: 'a1' });
		await a2.commit({ add: 'a2' });
		await b1.commit({ add: 'b1' });
		await b2.commit({ add: 'b2' });
		await settle();
		const want = ['a1', 'a2', 'b1', 'b2', 'host'];
		for (const s of [a1, a2, b1, b2]) expect(items(s)).toEqual(want);
		// Same order everywhere, not just the same set.
		expect(a2.doc.items).toEqual(a1.doc.items);
		expect(b1.doc.items).toEqual(a1.doc.items);
		expect(b2.doc.items).toEqual(a1.doc.items);
	});

	it('ops that do not commute still end identical', async () => {
		const { a1, b2 } = await call();
		await a1.commit({ add: 'k' });
		await settle();
		// Concurrent: one removes k, the other adds it again.
		await a1.commit({ remove: 'k' });
		await b2.commit({ add: 'k' });
		await settle();
		expect(b2.doc.items).toEqual(a1.doc.items);
	});

	it('previews cross the call; save notices do not', async () => {
		const devA = browser();
		const devB = browser();
		const got: string[] = [];
		const saves: number[] = [];
		const host = createDocSession<Doc, Op>({ room: 'fa', tab: devA.tab, initial: { items: [] }, reduce });
		const guest = createDocSession<Doc, Op>({
			room: 'fb',
			tab: devB.tab,
			initial: { items: [] },
			reduce,
			onTransient: (p) => got.push(String(p)),
			onSaved: (i) => saves.push(i.generation)
		});
		const wire = link();
		host.setPeer('invite', { role: 'sequencer', member: peerMember('invite', wire.a) });
		guest.setPeer('invite', { role: 'replica', member: peerMember('invite', wire.b) });
		await settle();
		host.sendTransient('cursor');
		host.announceSaved(3);
		await settle();
		expect(got).toEqual(['cursor']);
		expect(saves).toEqual([]);
	});

	it('the guest side keeps syncing between its tabs after the call ends', async () => {
		const { a1, b1, b2 } = await call();
		b1.setPeer('invite', null);
		a1.setPeer('invite', null);
		await settle();
		expect([b1.role, b2.role].sort()).toEqual(['follower', 'leader']);
		await b1.commit({ add: 'after' });
		await settle();
		expect(items(b2)).toEqual(['after', 'host']);
	});

	it('a joined session has no room: the peer alone', async () => {
		const devA = browser();
		const host = open(devA.tab, 'file-a', { items: ['theirs'] });
		const joiner = open(null, '');
		const wire = link();
		host.setPeer('join', { role: 'sequencer', member: peerMember('join', wire.a) });
		joiner.setPeer('join', { role: 'replica', member: peerMember('join', wire.b) });
		await settle();
		expect(items(joiner)).toEqual(['theirs']);
		await joiner.commit({ add: 'mine' });
		await settle();
		expect(items(host)).toEqual(['mine', 'theirs']);
	});

	it('the wire codec strips on the way out and rewrites on the way in, in order', async () => {
		const host = open(null, '', { items: ['secret:1', 'a'] });
		const guest = open(null, '');
		const wire = link();
		const strip = (f: Frame): Frame =>
			f.kind === 'snapshot' ? { ...f, doc: { items: (f.doc as Doc).items.filter((i) => !i.startsWith('secret')) } } : f;
		const remap = async (f: Frame): Promise<Frame> => {
			await new Promise((r) => setTimeout(r, f.kind === 'snapshot' ? 5 : 0));
			if (f.kind === 'edit' && f.op && 'add' in f.op) return { ...f, op: { add: `${f.op.add}@here` } };
			return f;
		};
		host.setPeer('p', { role: 'sequencer', member: peerMember('p', wire.a, { outbound: strip }) });
		guest.setPeer('p', { role: 'replica', member: peerMember('p', wire.b, { inbound: remap }) });
		await new Promise((r) => setTimeout(r, 20));
		await settle();
		expect(guest.doc.items).toEqual(['a']);
		await host.commit({ add: 'b' });
		await new Promise((r) => setTimeout(r, 30));
		await settle();
		expect(guest.doc.items).toEqual(['a', 'b@here']);
	});
});

describe('session engine: idle when alone', () => {
	it('builds no runtime with no room and no peer, and one once a peer comes', async () => {
		const { createSessionEngine } = await import('./sessionEngine.js');
		const built: string[] = [];
		const engine = createSessionEngine<Frame, { close(): void }>({
			clientId: 'c',
			room: '',
			tab: null,
			idleWhenAlone: true,
			runtime: (t) => {
				built.push(t.role);
				return { close: () => built.push('closed') };
			}
		});
		await settle();
		expect(built).toEqual([]);
		expect(engine.role).toBe('sequencer');
		const wire = link();
		engine.setPeer('p', { role: 'replica', member: peerMember('p', wire.a) });
		expect(built).toEqual(['replica']);
		engine.setPeer('p', null);
		expect(built).toEqual(['replica', 'closed']);
		engine.destroy();
	});
});
