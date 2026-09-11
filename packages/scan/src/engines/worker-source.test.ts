import { describe, expect, it } from 'vitest';
import { buildWorkerSource } from './opencv.worker-source.js';

/**
 * The worker is assembled from stringified functions, which is easy to break in
 * ways a type-check cannot see: a helper that stops being reachable, a call to
 * something that was never emitted, an alias pointing at a renamed function.
 * Evaluating the generated source catches all three, because an unresolved
 * top-level reference throws the moment it runs.
 */
describe('buildWorkerSource', () => {
	function evaluate(cv?: unknown) {
		const self: Record<string, unknown> = {
			cv,
			Module: null,
			fetch: () => undefined,
			onmessage: null,
			postMessage: () => undefined
		};
		const run = new Function('self', 'importScripts', buildWorkerSource());
		run(self, () => undefined);
		return self;
	}

	it('produces source that evaluates and installs a message handler', () => {
		expect(typeof evaluate().onmessage).toBe('function');
	});

	it('emits the algorithm rather than re-implementing it', () => {
		const src = buildWorkerSource();
		// A marker comment from the real module, carried through toString().
		expect(src).toContain('scoreDocument');
		expect(src).toContain('acceptFloor');
		expect(src.length).toBeGreaterThan(10_000);
	});

	it('wires the entry points through name aliases', () => {
		const src = buildWorkerSource();
		for (const alias of ['__detectQuad', '__warpImage', '__enhanceImage']) {
			// Declared once, and actually called by the handler.
			expect(src).toContain(`var ${alias} = `);
			expect(src.split(alias).length).toBeGreaterThan(2);
		}
	});

	it('refuses work before OpenCV has loaded', () => {
		const self = evaluate();
		const seen: { ok?: boolean; error?: string }[] = [];
		self.postMessage = (m: { ok?: boolean; error?: string }) => seen.push(m);
		(self.onmessage as (e: { data: unknown }) => void)({ data: { id: 1, type: 'detect' } });
		expect(seen[0]?.ok).toBe(false);
		expect(seen[0]?.error).toContain('not loaded');
	});

	it('reports a clear error for an unknown message once loaded', async () => {
		// A stub that satisfies the worker's readiness check, so the handler gets
		// past the load guard and reaches the message-type switch.
		const self = evaluate({ Mat: function Mat() {} });
		const seen: { id?: number; ok?: boolean; error?: string }[] = [];
		self.postMessage = (m: { id?: number; ok?: boolean; error?: string }) => seen.push(m);
		const post = self.onmessage as (e: { data: unknown }) => void;
		post({ data: { id: 1, type: 'init', url: 'stub' } });
		await Promise.resolve();
		await Promise.resolve();
		expect(seen.shift()).toEqual({ id: 1, ok: true });

		post({ data: { id: 2, type: 'nope' } });
		expect(seen[0]?.ok).toBe(false);
		expect(seen[0]?.error).toContain('Unknown OpenCV worker message');
	});
});
