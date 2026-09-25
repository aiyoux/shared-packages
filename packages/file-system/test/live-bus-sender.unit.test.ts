import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveBus } from '../src/live/bus.ts';
import { installLockPolyfill, type LockHarness } from './live-locks-harness.ts';

type Msg = { kind: 'commit'; n: number };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 1000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!fn() && Date.now() < deadline) await wait(5);
}

let seq = 0;
const nextChannel = () => `live-bus-sender-${process.pid}-${seq++}`;

let locks: LockHarness;
beforeEach(() => {
	locks = installLockPolyfill();
});
afterEach(() => {
	locks.reset();
	delete (globalThis as { navigator?: { locks?: unknown } }).navigator?.locks;
});

describe('createLiveBus sender liveness', () => {
	it('tells a receiver the moment a sender it heard from is gone — no timeout', async () => {
		const name = nextChannel();
		const a = createLiveBus<Msg>(name, 'a');
		const b = createLiveBus<Msg>(name, 'b');
		const got: number[] = [];
		const gone: string[] = [];
		b.onMessage((m) => got.push(m.n));
		b.onSenderGone((s) => gone.push(s));

		a.broadcast({ kind: 'commit', n: 1 });
		await until(() => got.length === 1);
		assert.deepEqual(gone, []);

		a.destroy(); // a tab closing: its sender lock is released
		await until(() => gone.length === 1);
		assert.deepEqual(gone, ['a']);
		b.destroy();
	});

	it('says nothing about a sender that is still there, however quiet', async () => {
		const name = nextChannel();
		const a = createLiveBus<Msg>(name, 'a');
		const b = createLiveBus<Msg>(name, 'b');
		const gone: string[] = [];
		const got: number[] = [];
		b.onMessage((m) => got.push(m.n));
		b.onSenderGone((s) => gone.push(s));
		a.broadcast({ kind: 'commit', n: 1 });
		await until(() => got.length === 1);
		await wait(150);
		assert.deepEqual(gone, []);
		a.destroy();
		b.destroy();
	});
});
