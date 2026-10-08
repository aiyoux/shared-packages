import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { schedulePreviewWork, sharedPreviewWork, observePreviewVisibility } from '../src/ui/previewWork.ts';
import { createListingRefresh } from '../src/ui/listingRefresh.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

describe('preview work', () => {
	it('caps concurrent work and never starts cancelled queued tiles', async () => {
		const hold = deferred<void>();
		let started = 0;
		const controllers = Array.from({ length: 1000 }, () => new AbortController());
		const jobs = controllers.map((c) => schedulePreviewWork(c.signal, async () => { started++; await hold.promise; }).catch(() => {}));
		await flush();
		assert.equal(started, 4);
		for (const c of controllers.slice(4)) c.abort();
		hold.resolve();
		await Promise.all(jobs);
		assert.equal(started, 4);
	});

	it('shares generation and lets one subscriber leave without cancelling another', async () => {
		const hold = deferred<number>();
		const first = new AbortController(), second = new AbortController();
		let started = 0;
		let workSignal!: AbortSignal;
		const task = async (signal: AbortSignal) => { started++; workSignal = signal; return hold.promise; };
		const a = sharedPreviewWork('same-file', first.signal, task).catch(() => 'cancelled');
		const b = sharedPreviewWork('same-file', second.signal, task);
		await flush();
		first.abort();
		assert.equal(workSignal.aborted, false);
		hold.resolve(42);
		assert.equal(await a, 'cancelled');
		assert.equal(await b, 42);
		assert.equal(started, 1);
	});

	it('aborts the underlying fetch when its last subscriber leaves', async () => {
		const controller = new AbortController();
		let workSignal!: AbortSignal;
		const task = sharedPreviewWork('aborted-file', controller.signal, async (signal) => {
			workSignal = signal;
			return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
		}).catch(() => 'cancelled');
		await flush(); controller.abort();
		assert.equal(await task, 'cancelled');
		assert.equal(workSignal.aborted, true);
		await flush();
	});

	it('uses one observer for a large directory and reports scroll exits', () => {
		const original = globalThis.IntersectionObserver;
		let created = 0;
		let notify!: (entries: { target: Element; isIntersecting: boolean }[]) => void;
		let disconnected = false;
		globalThis.IntersectionObserver = class {
			constructor(callback: typeof notify) { created++; notify = callback; }
			observe() {} unobserve() {} disconnect() { disconnected = true; }
		} as unknown as typeof IntersectionObserver;
		try {
			const nodes = Array.from({ length: 2000 }, () => ({} as Element));
			const visible: boolean[] = [];
			const actions = nodes.map((node) => observePreviewVisibility(node, (value) => visible.push(value)));
			assert.equal(created, 1); assert.equal(visible.length, 0);
			notify([{ target: nodes[0], isIntersecting: true }, { target: nodes[0], isIntersecting: false }]);
			assert.deepEqual(visible, [true, false]);
			for (const action of actions) action.destroy();
			assert.equal(disconnected, true);
		} finally { globalThis.IntersectionObserver = original; }
	});
});

describe('listing refresh', () => {
	it('coalesces bursts, serializes slow reads and delivers a trailing change', async (t) => {
		t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
		const hold = deferred<void>();
		let calls = 0;
		const queue = createListingRefresh(async () => { if (++calls === 1) await hold.promise; });
		for (let i = 0; i < 100; i++) queue.request();
		t.mock.timers.tick(120); await flush();
		assert.equal(calls, 1);
		for (let i = 0; i < 100; i++) queue.request();
		t.mock.timers.tick(1000); await flush();
		assert.equal(calls, 1);
		hold.resolve(); await flush();
		t.mock.timers.tick(120); await flush();
		assert.equal(calls, 2);
		queue.request(); queue.stop();
		t.mock.timers.tick(1000); await flush();
		assert.equal(calls, 2);
	});
});
