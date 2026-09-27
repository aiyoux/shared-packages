import { describe, expect, it } from 'vitest';
import { jsonChunker } from './peerLink.js';

describe('jsonChunker', () => {
	it('passes a small frame, and splits and rebuilds a large one', () => {
		const c = jsonChunker<{ kind: string; body: string }>(50);
		const small = { kind: 'edit', body: 'x' };
		expect(c.split(small)).toEqual([small]);
		const big = { kind: 'snapshot', body: 'y'.repeat(400) };
		const parts = c.split(big);
		expect(parts.length).toBeGreaterThan(1);
		let out: unknown = null;
		for (const p of parts.reverse()) out = c.push(p) ?? out;
		expect(out).toEqual(big);
	});

	it('rebuilds two split frames whose parts interleave', () => {
		const c = jsonChunker<{ kind: string; body: string }>(40);
		const a = c.split({ kind: 'snapshot', body: 'a'.repeat(200) });
		const b = c.split({ kind: 'snapshot', body: 'b'.repeat(200) });
		const done: unknown[] = [];
		for (let i = 0; i < Math.max(a.length, b.length); i++) {
			for (const p of [a[i], b[i]]) {
				if (!p) continue;
				const f = c.push(p);
				if (f) done.push(f);
			}
		}
		expect(done).toHaveLength(2);
	});
});
