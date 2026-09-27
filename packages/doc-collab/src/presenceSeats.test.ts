import { describe, expect, it } from 'vitest';
import { createPresenceSeats, type PresenceFrame } from './presenceSeats.js';

type Place = { at: number };

function seats(clientId: string, opts: { throttleMs?: number; canSpeak?: () => boolean; current?: () => Place | null } = {}) {
	const sent: PresenceFrame<Place>[] = [];
	let view: ReadonlyMap<string, Place> = new Map();
	let clock = 0;
	const timers: Array<{ at: number; fn: () => void }> = [];
	const s = createPresenceSeats<Place>({
		clientId,
		board: 'room',
		send: (f) => sent.push(f),
		sanitize: (_id, raw) => {
			const at = (raw as Place | null)?.at;
			return typeof at === 'number' && Number.isFinite(at) ? { at } : null;
		},
		onChange: (next) => (view = next),
		throttleMs: opts.throttleMs,
		canSpeak: opts.canSpeak,
		current: opts.current,
		now: () => clock,
		schedule: (fn, ms) => {
			const t = { at: clock + ms, fn };
			timers.push(t);
			return t as unknown as ReturnType<typeof setTimeout>;
		},
		cancel: (h) => {
			const i = timers.indexOf(h as unknown as (typeof timers)[number]);
			if (i >= 0) timers.splice(i, 1);
		}
	});
	const advance = (ms: number) => {
		clock += ms;
		for (const t of timers.splice(0).filter((t) => t.at <= clock)) t.fn();
	};
	return { s, sent, view: () => view, advance };
}

describe('createPresenceSeats', () => {
	it('keeps a seat per peer, drops it on a leave, and ignores its own echo', () => {
		const { s, view } = seats('me');
		s.receive({ kind: 'presence', clientId: 'p', state: { at: 1 } });
		s.receive({ kind: 'presence', clientId: 'me', state: { at: 9 } });
		expect([...view()]).toEqual([['p', { at: 1 }]]);
		s.receive({ kind: 'presence', clientId: 'p', state: null });
		expect(view().size).toBe(0);
	});

	it('a ping is not a leave, and is answered with where this client is', () => {
		const { s, sent, view } = seats('me');
		s.receive({ kind: 'presence', clientId: 'p', state: { at: 1 } });
		s.set({ at: 5 });
		sent.length = 0;
		s.receive({ kind: 'presence', clientId: 'p', state: null, ping: true });
		expect(view().get('p')).toEqual({ at: 1 });
		expect(sent).toEqual([{ kind: 'presence', clientId: 'me', state: { at: 5 } }]);
	});

	it('answers a ping from `current` before it has moved, and then owes a leave', () => {
		const { s, sent } = seats('me', { current: () => ({ at: 3 }) });
		s.receive({ kind: 'presence', clientId: 'p', state: null, ping: true });
		s.close();
		expect(sent.map((f) => f.state)).toEqual([{ at: 3 }, null]);
	});

	it('what the sanitizer rejects removes the seat instead of painting it', () => {
		const { s, view } = seats('me');
		s.receive({ kind: 'presence', clientId: 'p', state: { at: 1 } });
		s.receive({ kind: 'presence', clientId: 'p', state: { at: Infinity } });
		expect(view().size).toBe(0);
	});

	it('throttles keeping the latest state, so the last move is never lost', () => {
		const { s, sent, advance } = seats('me', { throttleMs: 60 });
		s.set({ at: 1 });
		s.set({ at: 2 });
		s.set({ at: 3 });
		expect(sent.map((f) => f.state)).toEqual([{ at: 1 }]);
		advance(60);
		expect(sent.map((f) => f.state)).toEqual([{ at: 1 }, { at: 3 }]);
	});

	it('says nothing, and answers nothing, until it may speak', () => {
		let ready = false;
		const { s, sent } = seats('me', { canSpeak: () => ready, current: () => ({ at: 1 }) });
		s.set({ at: 1 });
		s.receive({ kind: 'presence', clientId: 'p', state: null, ping: true });
		expect(sent).toEqual([]);
		ready = true;
		s.set({ at: 2 });
		expect(sent.map((f) => f.state)).toEqual([{ at: 2 }]);
	});

	it('close leaves only if it ever spoke, and clears every seat', () => {
		const quiet = seats('q');
		quiet.s.receive({ kind: 'presence', clientId: 'p', state: { at: 1 } });
		quiet.s.close();
		expect(quiet.sent).toEqual([]);
		expect(quiet.view().size).toBe(0);
		const spoke = seats('me');
		spoke.s.set({ at: 1 });
		spoke.s.close();
		expect(spoke.sent.at(-1)).toEqual({ kind: 'presence', clientId: 'me', state: null });
	});

	it('two clients of one room keep separate boards', () => {
		const a = seats('a');
		const b = seats('b');
		a.s.receive({ kind: 'presence', clientId: 'p', state: { at: 1 } });
		b.s.close();
		expect(a.s.seats().get('p')).toEqual({ at: 1 });
	});
});
