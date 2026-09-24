import { describe, expect, it } from 'vitest';
import { COLLAB_STALE_MS, staleIds } from './liveness.js';

describe('staleIds', () => {
	it('keeps a peer inside the window and drops one past it', () => {
		const seen = new Map<string, number>([
			['live', 5_000],
			['gone', 1_000]
		]);
		const edge = 1_000 + COLLAB_STALE_MS;
		expect(staleIds(seen, edge)).toEqual([]);
		expect(staleIds(seen, edge + 1)).toEqual(['gone']);
	});
});
