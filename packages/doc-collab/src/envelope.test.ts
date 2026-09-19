import { describe, expect, it } from 'vitest';
import {
	DEFAULT_COLLAB_APP,
	createCmEnvelopeSession,
	type CmEnvelope,
	type CmEnvelopeChunker
} from './envelope.js';

type Frame = { kind: string; n?: number };

function mockWire() {
	const sent: CmEnvelope[] = [];
	let handler: ((msg: CmEnvelope) => void) | undefined;
	return {
		sent,
		sendKb(msg: CmEnvelope) {
			sent.push(msg);
		},
		onKb(h: (msg: CmEnvelope) => void) {
			handler = h;
		},
		deliver(over: { app?: string; doc?: string; frame?: unknown } = {}) {
			const msg: CmEnvelope = { type: 'kb-collab', v: 1, frame: over.frame };
			if (over.app !== undefined) msg.app = over.app;
			if (over.doc !== undefined) msg.doc = over.doc;
			handler?.(msg);
		}
	};
}

describe('createCmEnvelopeSession', () => {
	it('queues frames that arrive before subscribe', () => {
		const wire = mockWire();
		const session = createCmEnvelopeSession<Frame>({
			sendKb: (m) => wire.sendKb(m),
			onKb: (h) => wire.onKb(h),
			app: 'sketch'
		});
		wire.deliver({ app: 'sketch', frame: { kind: 'hello' } });
		wire.deliver({ app: 'sketch', frame: { kind: 'snapshot', n: 1 } });
		const seen: Frame[] = [];
		session.subscribe((frame) => seen.push(frame));
		expect(seen.map((f) => f.kind)).toEqual(['hello', 'snapshot']);
	});

	it('drops a wrong app', () => {
		const wire = mockWire();
		const session = createCmEnvelopeSession<Frame>({
			sendKb: (m) => wire.sendKb(m),
			onKb: (h) => wire.onKb(h),
			app: 'sketch'
		});
		const seen: Frame[] = [];
		session.subscribe((frame) => seen.push(frame));
		wire.deliver({ app: 'kb', frame: { kind: 'hello' } });
		wire.deliver({ frame: { kind: 'hello' } });
		wire.deliver({ app: 'sketch', frame: { kind: 'hello' } });
		expect(seen).toEqual([{ kind: 'hello' }]);
	});

	it('treats an absent app as kb', () => {
		const wire = mockWire();
		const session = createCmEnvelopeSession<Frame>({
			sendKb: (m) => wire.sendKb(m),
			onKb: (h) => wire.onKb(h),
			app: DEFAULT_COLLAB_APP
		});
		const seen: Frame[] = [];
		session.subscribe((frame) => seen.push(frame));
		wire.deliver({ frame: { kind: 'hello' } });
		wire.deliver({ app: 'kb', frame: { kind: 'ops' } });
		wire.deliver({ app: 'sketch', frame: { kind: 'snapshot' } });
		expect(seen.map((f) => f.kind)).toEqual(['hello', 'ops']);
	});

	it('does not stamp app or doc on a kb send', () => {
		const wire = mockWire();
		const session = createCmEnvelopeSession<Frame>({
			sendKb: (m) => wire.sendKb(m),
			onKb: (h) => wire.onKb(h),
			app: 'kb'
		});
		session.send({ kind: 'hello' });
		expect(wire.sent).toEqual([{ type: 'kb-collab', v: 1, frame: { kind: 'hello' } }]);
		expect('app' in wire.sent[0]!).toBe(false);
		expect('doc' in wire.sent[0]!).toBe(false);
	});

	it('stamps a non-kb app and, when configured, doc', () => {
		const wire = mockWire();
		const session = createCmEnvelopeSession<Frame>({
			sendKb: (m) => wire.sendKb(m),
			onKb: (h) => wire.onKb(h),
			app: 'sketch',
			doc: 'doc-1'
		});
		session.send({ kind: 'hello' });
		expect(wire.sent).toEqual([
			{ type: 'kb-collab', v: 1, app: 'sketch', doc: 'doc-1', frame: { kind: 'hello' } }
		]);
	});

	it('a named doc session only accepts that doc (mux on one link)', () => {
		const wire = mockWire();
		const session = createCmEnvelopeSession<Frame>({
			sendKb: (m) => wire.sendKb(m),
			onKb: (h) => wire.onKb(h),
			app: 'sketch',
			doc: 'doc-1'
		});
		const seen: Frame[] = [];
		session.subscribe((frame) => seen.push(frame));
		wire.deliver({ app: 'sketch', frame: { kind: 'hello' } });
		wire.deliver({ app: 'sketch', doc: 'doc-1', frame: { kind: 'ops' } });
		wire.deliver({ app: 'sketch', doc: 'other', frame: { kind: 'snapshot' } });
		expect(seen.map((f) => f.kind)).toEqual(['ops']);
		session.send({ kind: 'strokes' });
		expect(wire.sent[0]).toEqual({
			type: 'kb-collab',
			v: 1,
			app: 'sketch',
			doc: 'doc-1',
			frame: { kind: 'strokes' }
		});
	});

	it('does not filter on doc when the session did not configure one', () => {
		const wire = mockWire();
		const session = createCmEnvelopeSession<Frame>({
			sendKb: (m) => wire.sendKb(m),
			onKb: (h) => wire.onKb(h),
			app: 'sketch'
		});
		const seen: Frame[] = [];
		session.subscribe((frame) => seen.push(frame));
		wire.deliver({ app: 'sketch', doc: 'whatever', frame: { kind: 'hello' } });
		expect(seen).toEqual([{ kind: 'hello' }]);
		session.send({ kind: 'ops' });
		expect(wire.sent[0]).toEqual({ type: 'kb-collab', v: 1, app: 'sketch', frame: { kind: 'ops' } });
	});

	it('calls onAccept for a frame that is still queued', () => {
		const wire = mockWire();
		const accepted: Frame[] = [];
		createCmEnvelopeSession<Frame>({
			sendKb: (m) => wire.sendKb(m),
			onKb: (h) => wire.onKb(h),
			app: 'kb',
			onAccept: (frame) => void accepted.push(frame)
		});
		wire.deliver({ frame: { kind: 'snapshot' } });
		expect(accepted).toEqual([{ kind: 'snapshot' }]);
	});

	it('delivers to subscribers before onAccept so ready cannot beat apply', () => {
		const wire = mockWire();
		const order: string[] = [];
		const session = createCmEnvelopeSession<Frame>({
			sendKb: (m) => wire.sendKb(m),
			onKb: (h) => wire.onKb(h),
			app: 'kb',
			onAccept: () => void order.push('accept')
		});
		session.subscribe(() => order.push('handler'));
		wire.deliver({ frame: { kind: 'snapshot' } });
		expect(order).toEqual(['handler', 'accept']);
	});

	it('drops further frames after close', () => {
		const wire = mockWire();
		const session = createCmEnvelopeSession<Frame>({
			sendKb: (m) => wire.sendKb(m),
			onKb: (h) => wire.onKb(h),
			app: 'sketch'
		});
		const seen: Frame[] = [];
		session.subscribe((frame) => seen.push(frame));
		session.close();
		wire.deliver({ app: 'sketch', frame: { kind: 'hello' } });
		session.send({ kind: 'ops' });
		expect(seen).toEqual([]);
		expect(wire.sent).toEqual([]);
	});

	it('does not throw on an unknown or missing kind', () => {
		const wire = mockWire();
		const session = createCmEnvelopeSession<Frame>({
			sendKb: (m) => wire.sendKb(m),
			onKb: (h) => wire.onKb(h),
			app: 'kb'
		});
		const seen: Frame[] = [];
		session.subscribe((frame) => seen.push(frame));
		expect(() => {
			wire.deliver({ frame: { kind: 'not-a-real-kind' } });
			wire.deliver({ frame: { n: 1 } });
			wire.deliver({ frame: null });
			wire.deliver({ frame: 'hello' });
			wire.deliver();
		}).not.toThrow();
		expect(seen).toEqual([{ kind: 'not-a-real-kind' }]);
	});

	it('splits and reassembles through an injected chunker', () => {
		const wire = mockWire();
		const reset: string[] = [];
		const chunk: CmEnvelopeChunker<Frame> = {
			split: (frame) => [{ kind: 'chunk', i: 0, n: 2, data: frame }, { kind: 'chunk', i: 1, n: 2, data: frame }],
			push: (part) => {
				const p = part as { kind: string; i: number; data: Frame };
				return p.i === 1 ? p.data : null;
			},
			reset: () => void reset.push('reset')
		};
		const session = createCmEnvelopeSession<Frame>({
			sendKb: (m) => wire.sendKb(m),
			onKb: (h) => wire.onKb(h),
			app: 'sketch',
			chunk
		});
		session.send({ kind: 'snapshot', n: 9 });
		expect(wire.sent).toHaveLength(2);
		expect(wire.sent.every((m) => m.app === 'sketch' && m.v === 1)).toBe(true);

		const seen: Frame[] = [];
		session.subscribe((frame) => seen.push(frame));
		wire.deliver({ app: 'sketch', frame: { kind: 'chunk', i: 0, n: 2, data: { kind: 'snapshot' } } });
		expect(seen).toEqual([]);
		wire.deliver({
			app: 'sketch',
			frame: { kind: 'chunk', i: 1, n: 2, data: { kind: 'snapshot', n: 9 } }
		});
		expect(seen).toEqual([{ kind: 'snapshot', n: 9 }]);

		session.close();
		expect(reset).toEqual(['reset']);
	});
});

describe('a peer that predates doc addressing', () => {
	it('reports the drop ONCE instead of going quiet', () => {
		// The failure this prevents: a named session silently ignores everything
		// an older peer sends, which looks identical to a link with nobody on it.
		const seen: unknown[] = [];
		let unaddressed = 0;
		let deliver: (m: CmEnvelope) => void = () => {};
		const session = createCmEnvelopeSession<{ kind: string }>({
			sendKb: () => {},
			onKb: (h) => {
				deliver = h;
			},
			app: 'sketch',
			doc: 'doc-1',
			onUnaddressed: () => {
				unaddressed += 1;
			}
		});
		session.subscribe((f) => seen.push(f));

		deliver({ type: 'kb-collab', v: 1, app: 'sketch', frame: { kind: 'hello' } });
		deliver({ type: 'kb-collab', v: 1, app: 'sketch', frame: { kind: 'ops' } });

		expect(seen).toEqual([]);
		expect(unaddressed, 'once per session, not once per frame').toBe(1);
	});

	it('does not fire for a frame addressed to a DIFFERENT doc', () => {
		// That is ordinary muxing, not an old peer, and reporting it would make
		// the signal useless on a link carrying several documents.
		let unaddressed = 0;
		let deliver: (m: CmEnvelope) => void = () => {};
		createCmEnvelopeSession<{ kind: string }>({
			sendKb: () => {},
			onKb: (h) => {
				deliver = h;
			},
			app: 'sketch',
			doc: 'doc-1',
			onUnaddressed: () => {
				unaddressed += 1;
			}
		});
		deliver({ type: 'kb-collab', v: 1, app: 'sketch', doc: 'doc-2', frame: { kind: 'ops' } });
		expect(unaddressed).toBe(0);
	});
});
