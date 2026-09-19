import { describe, expect, it, vi } from 'vitest';
import { createRelaySession, type RelayMember } from './relay.js';

type Frame = { body: string };

function member(id: string): RelayMember<Frame> & { sent: Frame[]; emit: (f: Frame) => void } {
	const handlers = new Set<(f: Frame) => void>();
	const sent: Frame[] = [];
	return {
		id,
		sent,
		send: (f) => void sent.push(f),
		subscribe(h) {
			handlers.add(h);
			return () => handlers.delete(h);
		},
		close: vi.fn(),
		emit: (f) => handlers.forEach((h) => h(f))
	};
}

describe('a replica gateway', () => {
	it('forwards a frame to the other transport, never back onto its own', () => {
		const bus = member('bus');
		const peer = member('peer');
		createRelaySession({ members: [bus, peer], forward: () => true });

		bus.emit({ body: 'from-a-sibling-tab' });
		expect(peer.sent).toEqual([{ body: 'from-a-sibling-tab' }]);
		expect(bus.sent).toEqual([]);

		peer.emit({ body: 'from-the-guest' });
		expect(bus.sent).toEqual([{ body: 'from-the-guest' }]);
		expect(peer.sent).toHaveLength(1);
	});

	it('shows the local runtime everything, whichever transport it came from', () => {
		const bus = member('bus');
		const peer = member('peer');
		const session = createRelaySession({ members: [bus, peer], forward: () => true });
		const seen: Frame[] = [];
		session.subscribe((f) => void seen.push(f));

		bus.emit({ body: 'a' });
		peer.emit({ body: 'b' });
		expect(seen).toEqual([{ body: 'a' }, { body: 'b' }]);
	});

	it('sends a local frame to every transport', () => {
		const bus = member('bus');
		const peer = member('peer');
		createRelaySession({ members: [bus, peer], forward: () => true }).send({ body: 'mine' });
		expect(bus.sent).toEqual([{ body: 'mine' }]);
		expect(peer.sent).toEqual([{ body: 'mine' }]);
	});
});

describe('a sequencer', () => {
	it('does NOT forward what it will number, but DOES forward what it will not', () => {
		const bus = member('bus');
		const peer = member('peer');
		const session = createRelaySession({ members: [bus, peer], forward: (f) => f.body === 'out-of-band' });
		const seen: Frame[] = [];
		session.subscribe((f) => void seen.push(f));

		bus.emit({ body: 'unstamped' });
		// Seen locally so it can be stamped and applied; not pushed onward,
		// which would put an unorderable frame on the far side.
		expect(seen).toEqual([{ body: 'unstamped' }]);
		expect(peer.sent).toEqual([]);

		// Out-of-band traffic — presence — has no stamped re-send to carry it,
		// so a blanket "a sequencer does not forward" would strand the guest's
		// cursor before it ever reached the sibling tab.
		bus.emit({ body: 'out-of-band' });
		expect(peer.sent).toEqual([{ body: 'out-of-band' }]);

		// The stamped re-send is an ordinary local send and reaches everyone,
		// including the transport the original arrived on.
		session.send({ body: 'stamped' });
		expect(peer.sent).toEqual([{ body: 'out-of-band' }, { body: 'stamped' }]);
		expect(bus.sent).toEqual([{ body: 'stamped' }]);
	});
});

describe('close', () => {
	it('closes every member and goes quiet', () => {
		const bus = member('bus');
		const peer = member('peer');
		const session = createRelaySession({ members: [bus, peer], forward: () => true });
		const seen: Frame[] = [];
		session.subscribe((f) => void seen.push(f));

		session.close();
		expect(bus.close).toHaveBeenCalled();
		expect(peer.close).toHaveBeenCalled();

		bus.emit({ body: 'after' });
		expect(seen).toEqual([]);
		expect(peer.sent).toEqual([]);
		session.send({ body: 'after' });
		expect(bus.sent).toEqual([]);
	});
});

describe('a frame that arrives before the runtime subscribes', () => {
	it('is replayed, not dropped', () => {
		// The relay subscribes to its members in its own constructor; the
		// runtime subscribes to the relay only after that returns. Both real
		// adapters replay their queued frames to their first subscriber, so a
		// join snapshot lands in exactly this window — and dropping it leaves a
		// peer connected to an empty document with no error anywhere.
		const bus = member('bus');
		const peer = member('peer');
		const session = createRelaySession({ members: [bus, peer], forward: () => true });

		peer.emit({ body: 'join-snapshot' });

		const seen: Frame[] = [];
		session.subscribe((f) => void seen.push(f));
		expect(seen).toEqual([{ body: 'join-snapshot' }]);
	});

	it('replays in arrival order, once', () => {
		const bus = member('bus');
		const session = createRelaySession({ members: [bus], forward: () => true });
		bus.emit({ body: 'first' });
		bus.emit({ body: 'second' });

		const a: Frame[] = [];
		session.subscribe((f) => void a.push(f));
		expect(a.map((f) => f.body)).toEqual(['first', 'second']);

		// Drained, so a second subscriber does not get the backlog again.
		const b: Frame[] = [];
		session.subscribe((f) => void b.push(f));
		expect(b).toEqual([]);
	});

	it('still forwards a queued frame to the other transport immediately', () => {
		// Forwarding is not gated on anyone listening locally: the sibling tab
		// is waiting for it either way.
		const bus = member('bus');
		const peer = member('peer');
		createRelaySession({ members: [bus, peer], forward: () => true });
		bus.emit({ body: 'early' });
		expect(peer.sent).toEqual([{ body: 'early' }]);
	});
});
