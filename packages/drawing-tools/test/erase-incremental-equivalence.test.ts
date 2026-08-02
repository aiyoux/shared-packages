import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { splitPathsByEraser } from '../src/eraser.ts';
import type { PathData } from '../src/types';

/**
 * Can a drag be committed in increments as the pointer moves — "apply the
 * eraser as you go" — and land where one pass at pointerup would have?
 *
 * Cutting is idempotent, so the SWEPT REGION composes perfectly: the union of
 * the chunks is the whole trail. What does not compose is `capPadding`. The
 * cut is "centerline within effectiveRadius, then padded by capPadding so the
 * surviving round cap does not bulge back in" — and padding only ever EXTENDS
 * an interval the raw radius already found. It cannot create one.
 *
 * So the first chunk to reach a stroke cuts it, and padding pushes the new end
 * `capPadding` beyond the raw reach. Every later chunk measures against the raw
 * radius, finds the piece now sits outside it, and leaves it alone. The cut
 * stops at roughly the raw radius instead of radius + padding.
 *
 * Incremental therefore erases LESS than batch, by up to about the ink's stroke
 * width — which is nothing on a hairline and very visible on a thick stroke.
 * These tests pin that as measured behaviour so the live-apply mode is built
 * with it in view rather than discovering it on a thick stroke later.
 */

const line = (d: string, extra: Partial<PathData> = {}): PathData => ({
	id: 'l', d, fill: 'none', stroke: '#000', strokeWidth: 4, layerId: 'default', ...extra
});

const trailAlong = (x1: number, y1: number, x2: number, y2: number, n: number) =>
	Array.from({ length: n + 1 }, (_, i) => ({ x: x1 + ((x2 - x1) * i) / n, y: y1 + ((y2 - y1) * i) / n }));

function applyIncrementally(paths: PathData[], trail: { x: number; y: number }[], radius: number, chunkSize: number) {
	let current = paths;
	for (let start = 0; start < trail.length - 1; start += chunkSize) {
		const chunk = trail.slice(start, Math.min(start + chunkSize + 1, trail.length));
		if (chunk.length < 2) continue;
		current = splitPathsByEraser(current, chunk, radius);
	}
	return current;
}

/** Width of the hole cut through a single horizontal stroke. */
const gapWidth = (paths: PathData[]) => {
	const spans = paths
		.map(p => { const n = (p.d.match(/-?\d+\.?\d*/g) || []).map(Number); return [n[0], n[2]] as [number, number]; })
		.sort((a, b) => a[0] - b[0]);
	return spans.length < 2 ? 0 : spans[1][0] - spans[0][1];
};

const RADIUS = 20;
const crossing = trailAlong(200, -60, 200, 60, 24);
const horizontal = (strokeWidth: number) => [line('M 0 0 L 400 0', { strokeWidth })];

describe('incremental erase vs one batch pass', () => {
	it('cuts at radius + capPadding in one pass', () => {
		for (const strokeWidth of [2, 8, 24]) {
			const gap = gapWidth(splitPathsByEraser(horizontal(strokeWidth), crossing, RADIUS));
			assert.ok(
				Math.abs(gap - 2 * (RADIUS + strokeWidth / 2)) < 0.5,
				`batch gap for strokeWidth ${strokeWidth} was ${gap}, expected ~${2 * (RADIUS + strokeWidth / 2)}`
			);
		}
	});

	it('never erases MORE when applied incrementally', () => {
		// The direction matters: incremental leaving extra ink is recoverable by
		// rubbing again, whereas incremental eating ink the batch pass would have
		// kept would be a correctness bug.
		for (const strokeWidth of [2, 4, 8, 16, 24]) {
			for (const chunkSize of [1, 3, 7]) {
				const batch = gapWidth(splitPathsByEraser(horizontal(strokeWidth), crossing, RADIUS));
				const incremental = gapWidth(applyIncrementally(horizontal(strokeWidth), crossing, RADIUS, chunkSize));
				assert.ok(
					incremental <= batch + 0.5,
					`strokeWidth ${strokeWidth} chunk ${chunkSize}: incremental gap ${incremental} exceeded batch ${batch}`
				);
			}
		}
	});

	it('falls short of the batch cut by at most the ink stroke width', () => {
		for (const strokeWidth of [2, 4, 8, 16, 24]) {
			const batch = gapWidth(splitPathsByEraser(horizontal(strokeWidth), crossing, RADIUS));
			const incremental = gapWidth(applyIncrementally(horizontal(strokeWidth), crossing, RADIUS, 1));
			const shortfall = batch - incremental;
			assert.ok(
				shortfall <= strokeWidth + 0.5,
				`strokeWidth ${strokeWidth}: incremental fell ${shortfall} short, more than the stroke width`
			);
		}
	});

	it('converges on the batch result as the chunks grow', () => {
		// Bigger chunks mean fewer seams, so a live-apply mode that batches a few
		// pointer moves before committing is closer to the one-pass answer than
		// one that commits every single move.
		const batch = gapWidth(splitPathsByEraser(horizontal(16), crossing, RADIUS));
		const shortfalls = [1, 3, 7, 24].map(
			chunk => batch - gapWidth(applyIncrementally(horizontal(16), crossing, RADIUS, chunk))
		);
		assert.ok(
			shortfalls[shortfalls.length - 1] <= shortfalls[0],
			`shortfall did not shrink with chunk size: ${shortfalls.join(', ')}`
		);
		assert.ok(
			Math.abs(shortfalls[shortfalls.length - 1]) < 0.5,
			`one whole-trail chunk should match the batch pass exactly, off by ${shortfalls[shortfalls.length - 1]}`
		);
	});

	it('agrees exactly for a drag running along a stroke rather than across it', () => {
		// No chunk seam lands on the cut here, so nothing depends on the padding.
		const along = trailAlong(40, 0, 360, 0, 40);
		const batch = splitPathsByEraser(horizontal(4), along, 15);
		for (const chunkSize of [1, 3, 7]) {
			const incremental = applyIncrementally(horizontal(4), along, 15, chunkSize);
			assert.deepEqual(
				incremental.map(p => p.d),
				batch.map(p => p.d),
				`chunks of ${chunkSize} diverged on an along-the-stroke drag`
			);
		}
	});
});
