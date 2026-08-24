import { describe, expect, it } from 'vitest';
import { clampPoint, collapsed, isCollapsed, orderedRange, payloadLength, requireBlock } from './range.js';
import { page, para } from './testFixtures.js';

describe('range helpers', () => {
	it('orderedRange treats missing ids as last and does not throw', () => {
		const doc = page([para('a', 'aa'), para('b', 'bb')]);
		expect(orderedRange(doc, { anchor: { blockId: 'a', offset: 1 }, head: { blockId: 'b', offset: 0 } })).toEqual({
			start: { blockId: 'a', offset: 1 },
			end: { blockId: 'b', offset: 0 }
		});
		expect(orderedRange(doc, { anchor: { blockId: 'missing', offset: 0 }, head: { blockId: 'b', offset: 1 } })).toEqual({
			start: { blockId: 'b', offset: 1 },
			end: { blockId: 'b', offset: 1 }
		});
		expect(orderedRange(doc, { anchor: { blockId: 'a', offset: 1 }, head: { blockId: 'gone', offset: 0 } })).toEqual({
			start: { blockId: 'a', offset: 1 },
			end: { blockId: 'a', offset: 1 }
		});
		expect(
			orderedRange(doc, { anchor: { blockId: 'x', offset: 0 }, head: { blockId: 'y', offset: 1 } })
		).toEqual({
			start: { blockId: 'x', offset: 0 },
			end: { blockId: 'y', offset: 1 }
		});
	});

	it('clampPoint snaps missing ids to the first block and clamps offsets', () => {
		const doc = page([para('a', 'aa'), para('b', 'bb')]);
		expect(clampPoint(doc, { blockId: 'missing', offset: 9 })).toEqual({ blockId: 'a', offset: 0 });
		expect(clampPoint(doc, { blockId: 'a', offset: 99 })).toEqual({ blockId: 'a', offset: 2 });
		expect(clampPoint(doc, { blockId: 'a', offset: -1 })).toEqual({ blockId: 'a', offset: 0 });
		expect(payloadLength(doc, 'missing')).toBe(0);
		expect(payloadLength(doc, 'a')).toBe(2);
	});

	it('requireBlock throws on unknown ids; collapsed detects equality', () => {
		const doc = page([para('a', 'aa')]);
		expect(() => requireBlock(doc, 'missing')).toThrow(/unknown block/);
		expect(requireBlock(doc, 'a').index).toBe(0);
		const c = collapsed({ blockId: 'a', offset: 1 });
		expect(isCollapsed(c)).toBe(true);
		expect(isCollapsed({ anchor: { blockId: 'a', offset: 0 }, head: { blockId: 'a', offset: 1 } })).toBe(
			false
		);
	});
});
