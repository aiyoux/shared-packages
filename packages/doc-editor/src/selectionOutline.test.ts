import { describe, expect, it } from 'vitest';
import {
	bridgeGaps,
	clipLineToOffsets,
	mergeLineRects,
	polygonFromSlabs,
	roundPolygonSvg,
	selectionOutlinePath,
	type Slab
} from './selectionOutline.js';
import type { LineBox } from './selection.js';

function line(partial: Partial<LineBox> & Pick<LineBox, 'top' | 'bottom' | 'left' | 'right'>): LineBox {
	return {
		startOffset: 0,
		endOffset: 10,
		...partial
	};
}

describe('clipLineToOffsets', () => {
	it('stops the last line after the last selected character, not the full line', () => {
		const box = line({
			top: 0,
			bottom: 16,
			left: 0,
			right: 200,
			startOffset: 0,
			endOffset: 10,
			glyphs: [
				{ offset: 0, left: 0, right: 10 },
				{ offset: 1, left: 10, right: 20 },
				{ offset: 2, left: 20, right: 30 },
				{ offset: 3, left: 30, right: 40 }
			]
		});
		const slab = clipLineToOffsets(box, 0, 3);
		expect(slab).toEqual({ top: 0, bottom: 16, left: 0, right: 30 });
	});

	it('starts the first line at the first selected character', () => {
		const box = line({
			top: 0,
			bottom: 16,
			left: 0,
			right: 200,
			startOffset: 0,
			endOffset: 4,
			glyphs: [
				{ offset: 0, left: 0, right: 10 },
				{ offset: 1, left: 10, right: 20 },
				{ offset: 2, left: 20, right: 30 },
				{ offset: 3, left: 30, right: 40 }
			]
		});
		expect(clipLineToOffsets(box, 2, 4)).toEqual({ top: 0, bottom: 16, left: 20, right: 40 });
	});
});

describe('bridgeGaps', () => {
	it('fills the vertical gap so stacked slabs read as one block', () => {
		const bridged = bridgeGaps([
			{ top: 0, bottom: 16, left: 40, right: 80 },
			{ top: 28, bottom: 44, left: 0, right: 200 }
		]);
		expect(bridged).toHaveLength(3);
		expect(bridged[1]).toEqual({ top: 16, bottom: 28, left: 0, right: 200 });
	});
});

describe('polygonFromSlabs', () => {
	it('builds a rectangle for a single slab', () => {
		expect(polygonFromSlabs([{ top: 0, bottom: 10, left: 2, right: 8 }])).toEqual([
			[2, 0],
			[8, 0],
			[8, 10],
			[2, 10]
		]);
	});

	it('steps out at a concave corner when a partial line meets a full block', () => {
		const pts = polygonFromSlabs([
			{ top: 0, bottom: 20, left: 50, right: 100 },
			{ top: 20, bottom: 40, left: 0, right: 200 }
		]);
		expect(pts).toContainEqual([100, 20]);
		expect(pts).toContainEqual([200, 20]);
		expect(pts).toContainEqual([0, 20]);
		expect(pts).toContainEqual([50, 20]);
		const d = roundPolygonSvg(pts, 5);
		expect(d).toContain('A ');
		expect(d.endsWith('Z')).toBe(true);
	});
});

describe('selectionOutlinePath', () => {
	it('returns a closed rounded path for stacked slabs', () => {
		const slabs: Slab[] = [
			{ top: 0, bottom: 16, left: 30, right: 90 },
			{ top: 16, bottom: 24, left: 0, right: 200 },
			{ top: 24, bottom: 40, left: 0, right: 200 }
		];
		const d = selectionOutlinePath(slabs, 5);
		expect(d.startsWith('M ')).toBe(true);
		expect(d.endsWith('Z')).toBe(true);
		expect(d).toContain('A ');
	});
});

describe('mergeLineRects', () => {
	it('unions fragments on the same visual line', () => {
		const merged = mergeLineRects([
			{ top: 0, bottom: 16, left: 0, right: 20 },
			{ top: 1, bottom: 15, left: 20, right: 40 }
		]);
		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({ left: 0, right: 40 });
	});
});
