import { describe, expect, it } from 'vitest';
import { createCollabRuntime } from './docRuntime.js';
import type { LogFrame } from './seqLog.js';

type Frame = LogFrame & {
	sequencer?: string;
	kind: 'snapshot' | 'edit';
	value: number;
};
const frame = (
	kind: Frame['kind'],
	value: number,
	seq: number,
	clientId = 'leader',
	frameId = 'f'
): Frame => ({
	kind,
	value,
	seq,
	clientId,
	frameId,
	scope: 'doc',
	sequencer: 'leader'
});
function replica() {
	let value = 0;
	const sent: Frame[] = [];
	let repairs = 0;
	const runtime = createCollabRuntime<Frame>({
		policy: 'ordered-frames',
		role: 'replica',
		clientId: 'me',
		apply: 'sequenced',
		send: (f) => sent.push(f),
		isSnapshot: (f) => f.kind === 'snapshot',
		applyFrame(f) {
			value = f.kind === 'snapshot' ? f.value : value + f.value;
			return true;
		},
		onRepair: () => {
			repairs++;
		}
	});
	runtime.receive(frame('snapshot', 0, 1));
	return { runtime, sent, value: () => value, repairs: () => repairs };
}

describe('one ordered frame runtime', () => {
	it('accepts a restarted sequencer on the same client', () => {
		const r = replica();
		r.runtime.receive(frame('snapshot', 10, 20));
		const sent: Frame[] = [];
		const start = () => createCollabRuntime<Frame>({
			policy: 'ordered-frames', role: 'sequencer', clientId: 'leader',
			send: f => sent.push(f), isSnapshot: f => f.kind === 'snapshot',
			applyFrame: () => true, onRepair: () => {}
		});
		const first = start();
		first.submit(frame('snapshot', 11, 0));
		r.runtime.receive(sent.at(-1)!);
		const firstIdentity = sent.at(-1)!.sequencer;
		first.close();
		const second = start();
		second.submit(frame('snapshot', 12, 0));
		expect(sent.at(-1)!.sequencer).not.toBe(firstIdentity);
		r.runtime.receive(sent.at(-1)!);
		second.submit(frame('edit', 1, 0));
		r.runtime.receive(sent.at(-1)!);
		expect(r.value()).toBe(13);
	});

	it('waits for and applies an own echo once, in sequence', () => {
		const r = replica();
		r.runtime.submit(frame('edit', 2, 0, 'me', 'own'));
		expect(r.value()).toBe(0);
		r.runtime.receive(frame('edit', 3, 2));
		r.runtime.receive(frame('edit', 2, 3, 'me', 'own'));
		r.runtime.receive(frame('edit', 2, 3, 'me', 'own'));
		expect(r.value()).toBe(5);
	});
	it('repairs a missing edit even when the next frame is its own echo', () => {
		const r = replica();
		r.runtime.submit(frame('edit', 2, 0, 'me', 'own'));
		r.runtime.receive(frame('edit', 2, 3, 'me', 'own'));
		expect(r.repairs()).toBe(1);
		expect(r.value()).toBe(0);
		r.runtime.receive(frame('snapshot', 7, 4));
		r.runtime.receive(frame('edit', 2, 3, 'me', 'own'));
		expect(r.value()).toBe(7);
	});
	it('keeps an outstanding edit ordered after a same-authority snapshot', () => {
		const r = replica();
		r.runtime.submit(frame('edit', 2, 0, 'me', 'own'));
		r.runtime.receive(frame('snapshot', 5, 2));
		r.runtime.receive(frame('edit', 2, 3, 'me', 'own'));
		expect(r.value()).toBe(7);
	});
	it('restarts the count only from a new sequencer snapshot', () => {
		const r = replica();
		r.runtime.receive({ ...frame('edit', 2, 2), sequencer: 'new' });
		expect(r.repairs()).toBe(1);
		r.runtime.receive({ ...frame('snapshot', 5, 1), sequencer: 'new' });
		expect(r.value()).toBe(5);
	});
	it('makes close stop receive and submit', () => {
		const r = replica();
		r.runtime.close();
		r.runtime.submit(frame('edit', 2, 0, 'me'));
		r.runtime.receive(frame('edit', 2, 2));
		expect(r.value()).toBe(0);
		expect(r.sent).toHaveLength(0);
	});
});
