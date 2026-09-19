import { describe, expect, it } from 'vitest';
import { MAX_PRESENCE_NAME, PRESENCE_COLORS, colorForClient } from './presence.js';

describe('colorForClient', () => {
	it('is byte-identical for a known clientId', () => {
		// 31-hash of 'guest' is 98708952; % 5 → index 2 → --cat-amber.
		expect(colorForClient('guest')).toBe('var(--cat-amber)');
	});

	it('is stable for an id and always in the palette', () => {
		for (const id of ['a', 'guest-1', '', 'c7f3-9910-aa']) {
			const color = colorForClient(id);
			expect(color).toBe(colorForClient(id));
			expect((PRESENCE_COLORS as readonly string[]).includes(color)).toBe(true);
		}
	});

	it('spreads ids across the palette rather than picking one', () => {
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) seen.add(colorForClient(`client-${i}`));
		expect(seen.size).toBe(PRESENCE_COLORS.length);
	});
});

describe('presence palette', () => {
	it('is the cat-token order Creative already shipped', () => {
		expect(PRESENCE_COLORS).toEqual([
			'var(--cat-blue)',
			'var(--cat-emerald)',
			'var(--cat-amber)',
			'var(--cat-violet)',
			'var(--cat-rose)'
		]);
		expect(MAX_PRESENCE_NAME).toBe(24);
	});
});
