import { describe, expect, it } from 'vitest';
import { hasUnpairedSurrogate, isHighSurrogate, isLowSurrogate, snapOffset } from './utf16.js';

const EMOJI = 'a👍b'; // offsets 0,1,3,4 — index 2 sits between the pair

describe('utf16', () => {
	it('classifies surrogates for 👍', () => {
		expect(EMOJI.length).toBe(4);
		expect(isHighSurrogate(EMOJI.charCodeAt(1))).toBe(true);
		expect(isLowSurrogate(EMOJI.charCodeAt(2))).toBe(true);
		expect(isHighSurrogate(EMOJI.charCodeAt(0))).toBe(false);
		expect(isLowSurrogate(EMOJI.charCodeAt(3))).toBe(false);
	});

	it('snaps an interior low-surrogate offset to the high-surrogate index', () => {
		expect(snapOffset(EMOJI, 0)).toBe(0);
		expect(snapOffset(EMOJI, 1)).toBe(1);
		expect(snapOffset(EMOJI, 2)).toBe(1);
		expect(snapOffset(EMOJI, 3)).toBe(3);
		expect(snapOffset(EMOJI, 4)).toBe(4);
	});

	it('does not invent unpaired surrogates when snapping', () => {
		for (const offset of [0, 1, 2, 3, 4, -1, 99]) {
			const snapped = snapOffset(EMOJI, offset);
			if (snapped > 0 && snapped < EMOJI.length) {
				expect(isLowSurrogate(EMOJI.charCodeAt(snapped)) && isHighSurrogate(EMOJI.charCodeAt(snapped - 1))).toBe(
					false
				);
			}
		}
		expect(hasUnpairedSurrogate(EMOJI)).toBe(false);
	});

	it('treats orphan surrogates as already-legal indexes', () => {
		expect(snapOffset('\uD83D', 0)).toBe(0);
		expect(snapOffset('\uD83D', 1)).toBe(1);
		expect(snapOffset('\uDC4D', 0)).toBe(0);
	});
});
