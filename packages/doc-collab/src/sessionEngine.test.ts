import { DocOpRejected } from './commitResult.js';
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

	it("a follower tab's save notice reaches the sequencer's tab and every other", async () => {
		const { tab } = browser();
		const saves: string[] = [];
		const mk = (name: string) =>
			createDocSession<Doc, Op>({
				room: 'f',
				tab,
				initial: { items: [] },
				reduce,
				onSaved: (info) => saves.push(`${name}:${info.generation}:${info.local}`)
			});
		const a = mk('a');
		await settle();
		const b = mk('b');
		const c = mk('c');
		await settle();
		expect([a.role, b.role, c.role]).toEqual(['leader', 'follower', 'follower']);
		// Any tab may write the session's file (a window's Save runs where it is).
		b.announceSaved(4);
		await settle();
		expect(saves.sort()).toEqual(['a:4:false', 'b:4:true', 'c:4:false']);
	});
});

describe("session engine: the sequencer's tab dies with an edit unanswered", () => {
	/** A leads; B is next in the lock's queue, C after it. */
	async function three() {
		const { tab } = browser();
		const a = open(tab, 'r', { items: ['x'] });
		await settle();
		const b = open(tab, 'r');
		await settle();
		const c = open(tab, 'r');
		await settle();
		expect([a.role, b.role, c.role]).toEqual(['leader', 'follower', 'follower']);
		return { a, b, c };
	}

	it('the tab that takes over sends its own again', async () => {
		const { a, b, c } = await three();
		void b.commit({ add: 'b' });
		// Gone in the same turn: before the bus delivers the edit to it.
		a.destroy();
		await settle();
		expect(b.role).toBe('leader');
		expect(items(b)).toEqual(['b', 'x']);
		expect(items(c)).toEqual(['b', 'x']);
	});

	it('a tab that stays a follower sends its own to the new sequencer', async () => {
		const { a, b, c } = await three();
		void c.commit({ add: 'c' });
		a.destroy();
		await settle();
		expect(b.role).toBe('leader');
		expect(c.role).toBe('follower');
		expect(items(b)).toEqual(['c', 'x']);
		expect(items(c)).toEqual(['c', 'x']);
		// Once only: later edits number after it, nothing lands twice.
		await c.commit({ add: 'd' });
		await settle();
		expect(items(b)).toEqual(['c', 'd', 'x']);
		expect(items(c)).toEqual(items(b));
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

	it('a dropped link takes everyone who spoke over it with it, for the other tabs too', async () => {
		const { a1, a2, b2 } = await call();
		const seen: Array<{ clientId: string; state: unknown }> = [];
		a2.engine.onFrame((frame) => {
			const f = frame as unknown as { kind: string; clientId: string; state: unknown };
			if (f.kind === 'presence') seen.push({ clientId: f.clientId, state: f.state });
		});
		// B2 speaks; it reaches A2 through B's gateway, the call, and A's gateway.
		b2.engine.send({ kind: 'presence', clientId: 'b2-seat', state: { at: 1 } } as unknown as Frame);
		await settle();
		expect(seen).toEqual([{ clientId: 'b2-seat', state: { at: 1 } }]);
		// The host's gateway drops the call without B saying goodbye.
		a1.setPeer('invite', null);
		await settle();
		expect(seen.at(-1)).toEqual({ clientId: 'b2-seat', state: null });
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

describe('doc session: presence', () => {
	type Place = { at: number };
	const keep = (_id: string, raw: unknown): Place | null => {
		const at = (raw as { at?: unknown } | null)?.at;
		return typeof at === 'number' ? { at } : null;
	};

	function seatsOn(s: DocSession<Doc, Op>) {
		let seen: ReadonlyMap<string, Place> = new Map();
		const seats = s.presence<Place>({ sanitize: keep, onChange: (m) => (seen = m) });
		return { seats, seen: () => seen };
	}

	it('another tab sees where this one is, and loses it when it leaves', async () => {
		const { tab } = browser();
		const a = open(tab, 'r');
		const b = open(tab, 'r');
		await settle();
		const pa = seatsOn(a);
		const pb = seatsOn(b);
		pa.seats.set({ at: 3 });
		await settle();
		expect([...pb.seen()]).toEqual([[a.clientId, { at: 3 }]]);
		pa.seats.close();
		await settle();
		expect(pb.seen().size).toBe(0);
	});

	it('a newcomer asks and hears peers who are not moving', async () => {
		const { tab } = browser();
		const a = open(tab, 'r');
		await settle();
		seatsOn(a).seats.set({ at: 1 });
		const b = open(tab, 'r');
		await settle();
		const pb = seatsOn(b);
		pb.seats.ask();
		await settle();
		expect([...pb.seen()]).toEqual([[a.clientId, { at: 1 }]]);
	});

	it('destroying the session leaves', async () => {
		const { tab } = browser();
		const a = open(tab, 'r');
		const b = open(tab, 'r');
		await settle();
		seatsOn(a).seats.set({ at: 2 });
		const pb = seatsOn(b);
		await settle();
		pb.seats.ask();
		await settle();
		expect(pb.seen().size).toBe(1);
		a.destroy();
		await settle();
		expect(pb.seen().size).toBe(0);
	});

	it("a dropped link takes the guest's seat from the host's other tab", async () => {
		const devA = browser();
		const devB = browser();
		const a1 = open(devA.tab, 'file-a');
		await settle();
		const a2 = open(devA.tab, 'file-a');
		const b1 = open(devB.tab, 'file-b');
		await settle();
		const wire = link();
		a1.setPeer('invite', { role: 'sequencer', member: peerMember('invite', wire.a) });
		b1.setPeer('invite', { role: 'replica', member: peerMember('invite', wire.b) });
		await settle();
		const pa2 = seatsOn(a2);
		seatsOn(b1).seats.set({ at: 7 });
		await settle();
		expect([...pa2.seen()]).toEqual([[b1.clientId, { at: 7 }]]);
		a1.setPeer('invite', null);
		await settle();
		expect(pa2.seen().size).toBe(0);
	});
});


describe('confirmed document operations', () => {
	it('confirms follower edits, rejects domain failures without repair, and remembers results on join', async () => {
		const b = browser();
		const guarded = (d: Doc, op: Op) => { if ('add' in op && op.add === 'invalid') throw new DocOpRejected('Not allowed'); return reduce(d, op); };
		const a = createDocSession<Doc, Op>({ room: 'confirmed', clientId: 'a', tab: b.tab, initial: { items: [] }, reduce: guarded });
		const follower = createDocSession<Doc, Op>({ room: 'confirmed', clientId: 'b', tab: b.tab, initial: { items: [] }, reduce: guarded });
		await settle();
		let resolved = false;
		const pending = follower.commitConfirmed({ add: 'valid' }, { requestId: 'valid-request' }).then(r => { resolved = true; return r; });
		expect(resolved).toBe(false); await settle(); expect(await pending).toEqual({ accepted: true, changed: true });
		const rejection = follower.commitConfirmed({ add: 'invalid' }, { requestId: 'invalid-request' });
		await settle(); expect(await rejection).toEqual({ accepted: false, message: 'Not allowed' }); expect(a.doc).toEqual(follower.doc); expect(a.doc.items).toEqual(['valid']);
		const c = createDocSession<Doc, Op>({ room: 'confirmed', clientId: 'c', tab: b.tab, initial: { items: [] }, reduce: guarded }); await settle();
		expect(await c.commitConfirmed({ add: 'valid' }, { requestId: 'valid-request' })).toEqual({ accepted: true, changed: true });
		expect(await c.commitConfirmed({ add: 'invalid' }, { requestId: 'invalid-request' })).toEqual({ accepted: false, message: 'Not allowed' });
		expect(c.doc.items).toEqual(['valid']); a.destroy(); follower.destroy(); c.destroy();
	});
	it('resubmits a pending request across sequencer handoff exactly once', async () => {
		const b = browser(); const a = createDocSession<Doc, Op>({ room: 'handoff-result', clientId: 'a', tab: b.tab, initial: { items: [] }, reduce });
		const follower = createDocSession<Doc, Op>({ room: 'handoff-result', clientId: 'b', tab: b.tab, initial: { items: [] }, reduce }); await settle();
		const pending = follower.commitConfirmed({ add: 'once' }, { requestId: 'handoff' }); a.destroy(); await settle();
		expect(await pending).toEqual({ accepted: true, changed: true }); expect(follower.doc.items).toEqual(['once']);
		await follower.commitConfirmed({ add: 'once' }, { requestId: 'handoff' }); expect(follower.doc.items).toEqual(['once']); follower.destroy();
	});
	it('cancels a wait without undoing its edit, and rejects pending waits when the session ends', async () => {
		const b = browser(); const a = createDocSession<Doc, Op>({ room: 'cancel-result', clientId: 'a', tab: b.tab, initial: { items: [] }, reduce });
		const follower = createDocSession<Doc, Op>({ room: 'cancel-result', clientId: 'b', tab: b.tab, initial: { items: [] }, reduce }); await settle();
		const ctl = new AbortController(); const pending = follower.commitConfirmed({ add: 'applied' }, { signal: ctl.signal });
		const asserted = expect(pending).rejects.toThrow(); ctl.abort(new Error('Cancelled')); await asserted; await settle(); expect(a.doc.items).toEqual(['applied']);
		const queued = createDocSession<Doc, Op>({ room: 'unready', tab: b.tab, initial: { items: [] }, reduce });
		const waiting = queued.commitConfirmed({ add: 'never' }); const ended = expect(waiting).rejects.toThrow(/session ended/); queued.destroy(); await ended;
		a.destroy(); follower.destroy();
	});
});

describe('session engine: the save anchor (fileGeneration)', () => {
	it('is null until a read, a snapshot or a saved frame anchors it, and moves with every save notice', async () => {
		const b = browser();
		const alone = createDocSession<Doc, Op>({ room: 'anchor-alone', clientId: 'z', tab: b.tab, initial: { items: [] }, reduce });
		await settle();
		expect(alone.fileGeneration).toBeNull();
		const anchored = createDocSession<Doc, Op>({ room: 'anchor', clientId: 'a', tab: b.tab, initial: { items: [] }, reduce, initialGeneration: 3 });
		await settle();
		expect(anchored.fileGeneration).toBe(3);
		// Joining takes the sequencer's document, and the base it came with.
		const joined = createDocSession<Doc, Op>({ room: 'anchor', clientId: 'b', tab: b.tab, initial: { items: [] }, reduce });
		await settle();
		expect(joined.fileGeneration).toBe(3);
		joined.announceSaved(5);
		await settle();
		// The announced save moves both the session's own anchor and a
		// room-mate's, like a `saved` frame does.
		expect(joined.fileGeneration).toBe(5);
		expect(anchored.fileGeneration).toBe(5);
		alone.destroy(); anchored.destroy(); joined.destroy();
	});

	it('adoptFileGeneration seeds it locally and broadcasts nothing', async () => {
		const b = browser();
		const a = createDocSession<Doc, Op>({ room: 'adopt', clientId: 'a', tab: b.tab, initial: { items: [] }, reduce });
		await settle();
		const b2 = createDocSession<Doc, Op>({ room: 'adopt', clientId: 'c', tab: b.tab, initial: { items: [] }, reduce });
		await settle();
		a.adoptFileGeneration(9);
		await settle();
		expect(a.fileGeneration).toBe(9);
		// No frame carries a local adoption: the room-mate still knows nothing.
		expect(b2.fileGeneration).toBeNull();
		// It replaces an anchor the session already had; whether to call it is
		// the caller's decision (`windowSession` only seeds an unanchored one).
		const d = createDocSession<Doc, Op>({ room: 'adopt-2', clientId: 'd', tab: b.tab, initial: { items: [] }, reduce, initialGeneration: 2 });
		await settle();
		d.adoptFileGeneration(4);
		expect(d.fileGeneration).toBe(4);
		a.destroy(); b2.destroy(); d.destroy();
	});

	it("a tab that takes the sequencer's document takes its file base too", async () => {
		const b = browser();
		// The first tab read generation 3 and edited.
		const a = createDocSession<Doc, Op>({ room: 'base', clientId: 'a', tab: b.tab, initial: { items: ['edit'] }, reduce, initialGeneration: 3 });
		await settle();
		// A foreign write moved the file to 4; a second tab reads that and
		// seeds its anchor from it before it hears the sequencer.
		const late = createDocSession<Doc, Op>({ room: 'base', clientId: 'b', tab: b.tab, initial: { items: [] }, reduce });
		late.adoptFileGeneration(4);
		await settle();
		// It shows the first tab's edits, so its save must CAS against their
		// base: anchored at 4 it would stamp over the foreign write.
		expect(late.doc.items).toEqual(['edit']);
		expect(late.fileGeneration).toBe(3);
		a.destroy(); late.destroy();
	});
});
