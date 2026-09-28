import { describe, expect, it } from 'vitest';
import { createCollabRuntime } from './docRuntime.js';
import type { ExactBaseEvent } from './exactBaseRuntime.js';

type Frame =
	ExactBaseEvent<string, string> | { kind: 'recover'; documentId: string };
function replica() {
	let doc = '';
	let receive!: (frame: Frame) => void;
	const sent: Frame[] = [];
	const runtime = createCollabRuntime<string, string, Frame>({
		policy: 'exact-base',
		documentId: 'local',
		authority: null,
		transport: {
			role: 'replica',
			clientId: 'me',
			send: (frame) => sent.push(frame),
			subscribe(handler) {
				receive = handler;
				return () => {};
			},
			close() {}
		},
		port: {
			snapshot: () => doc,
			replace: (next) => {
				doc = next;
			},
			apply: (ops) => {
				doc += ops.join('');
			}
		},
		codec: {
			read: (frame) => (frame.kind === 'recover' ? null : frame),
			hello: () => ({ kind: 'hello', clientId: 'me' }),
			recover: (documentId) => ({ kind: 'recover', documentId }),
			ops: (documentId, ops, submissionId) => ({
				kind: 'ops',
				documentId,
				ops,
				submissionId,
				clientId: 'me',
				seq: 0
			}),
			replaced: (documentId) => ({ kind: 'resync', documentId, replace: true })
		}
	});
	return {
		runtime,
		receive: (frame: Frame) => receive(frame),
		sent,
		doc: () => doc
	};
}

describe('shared exact-base policy', () => {
	it('holds input until the owner snapshot arrives and adopts its document identity', () => {
		const r = replica();
		r.runtime.submit(['before join']);
		expect(r.sent).toHaveLength(1);
		r.receive({ kind: 'snapshot', documentId: 'owner', seq: 0, doc: 'seed' });
		r.runtime.submit(['edit']);
		expect(r.sent.at(-1)).toMatchObject({
			kind: 'ops',
			documentId: 'owner',
			ops: ['edit']
		});
		expect(r.runtime.ready).toBe(true);
	});
	it('recovers whether the snapshot arrives before or after its rejection', () => {
		for (const snapshotFirst of [true, false]) {
			const r = replica();
			r.receive({ kind: 'snapshot', documentId: 'owner', seq: 0, doc: 'seed' });
			const snapshot: Frame = {
				kind: 'snapshot',
				documentId: 'owner',
				seq: 2,
				doc: 'repaired'
			};
			const nack: Frame = { kind: 'nack', headSeq: 2 };
			if (snapshotFirst) {
				r.receive(snapshot);
				r.receive(nack);
				r.receive({ kind: 'ack', submissionId: 'previous', seq: 2 });
			} else {
				r.receive(nack);
				r.receive(snapshot);
			}
			expect(r.doc()).toBe('repaired');
		}
	});
	it('replays later edits after the recovery snapshot, once', () => {
		const r = replica();
		r.receive({ kind: 'snapshot', documentId: 'owner', seq: 0, doc: 'seed' });
		r.receive({ kind: 'nack', headSeq: 2 });
		r.receive({
			kind: 'ops',
			documentId: 'owner',
			seq: 3,
			ops: ['!'],
			clientId: 'peer',
			submissionId: 'later'
		});
		r.receive({
			kind: 'snapshot',
			documentId: 'owner',
			seq: 2,
			doc: 'repaired'
		});
		expect(r.doc()).toBe('repaired!');
	});
	it('stops input when schema compatibility fails', () => {
		const r = replica();
		r.receive({ kind: 'snapshot', documentId: 'owner', seq: 0, doc: 'seed' });
		r.receive({ kind: 'read-only' });
		r.runtime.submit(['edit']);
		expect(r.sent).toHaveLength(1);
		expect(r.runtime.ready).toBe(false);
	});
});
