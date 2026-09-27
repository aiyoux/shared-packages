import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { browserEngineTab } from '../src/live/engineTab.ts';
import { installLockPolyfill, type LockHarness } from './live-locks-harness.ts';

type Frame = { kind: 'presence'; clientId: string; state: unknown; ping?: true } | { kind: 'edit'; n: number };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 1000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!fn() && Date.now() < deadline) await wait(5);
}

let seq = 0;
const nextRoom = () => `engine-tab-presence-${process.pid}-${seq++}`;

let locks: LockHarness;
beforeEach(() => {
	locks = installLockPolyfill();
});
afterEach(() => {
	locks.reset();
	delete (globalThis as { navigator?: { locks?: unknown } }).navigator?.locks;
});

describe('browserEngineTab presence liveness', () => {
	it('a tab that is gone takes every client it spoke for with it — itself and those it relayed', async () => {
		const room = nextRoom();
		const tab = browserEngineTab<Frame>({ isImmediate: (f) => f.kind === 'presence', persist: false });
		const gateway = tab.member(room, 'gateway');
		const other = tab.member(room, 'other');
		const got: Frame[] = [];
		other.subscribe((f) => got.push(f));

		gateway.send({ kind: 'presence', clientId: 'gateway', state: { at: 1 } });
		gateway.send({ kind: 'presence', clientId: 'guest', state: { at: 2 } });
		gateway.send({ kind: 'presence', clientId: 'left-already', state: { at: 3 } });
		gateway.send({ kind: 'presence', clientId: 'left-already', state: null });
		gateway.send({ kind: 'presence', clientId: 'pinger', state: null, ping: true });
		await until(() => got.length === 5);

		gateway.close(); // the tab closing: its sender lock is released
		await until(() => got.length === 8);
		const leaves = got.slice(5).map((f) => (f.kind === 'presence' ? [f.clientId, f.state] : null));
		assert.deepEqual(leaves.sort(), [
			['gateway', null],
			['guest', null],
			['pinger', null]
		]);
		other.close();
	});

	it('makes nothing up for a tab that is still there', async () => {
		const room = nextRoom();
		const tab = browserEngineTab<Frame>({ persist: false });
		const a = tab.member(room, 'a');
		const b = tab.member(room, 'b');
		const got: Frame[] = [];
		b.subscribe((f) => got.push(f));
		a.send({ kind: 'presence', clientId: 'a', state: { at: 1 } });
		await until(() => got.length === 1);
		await wait(150);
		assert.equal(got.length, 1);
		a.close();
		b.close();
	});
});
