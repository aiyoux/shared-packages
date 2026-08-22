import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { eraserSweptRegionPath, eraserOutlinePolygon } from '../src/eraser.ts';

/**
 * The live fade stand-in paints `eraserSweptRegionPath`; the commit cuts with
 * `eraserOutlinePolygon`. They are two renderings of ONE construction — the
 * same offset ring on the same 0.1 grid — differing only in how the ring's
 * self-crossings get resolved: a nonzero fill for the stand-in, a boolean
 * `union` for the cut. This pins that the two resolutions agree, because the
 * whole point of the stand-in is that swapping it for the cut changes nothing.
 */

type Pt = { x: number; y: number };

/** Rings of an `M x y L x y … Z` (possibly multi-subpath) path. */
function ringsOf(d: string): Pt[][] {
	return d
		.split('M')
		.slice(1)
		.map((chunk) => {
			const n = (chunk.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
			const ring: Pt[] = [];
			for (let i = 0; i + 1 < n.length; i += 2) ring.push({ x: n[i], y: n[i + 1] });
			return ring;
		})
		.filter((r) => r.length >= 3);
}

/** Winding number of `p` about one ring (rings are implicitly closed). */
function winding(ring: Pt[], p: Pt): number {
	let w = 0;
	for (let i = 0; i < ring.length; i++) {
		const a = ring[i], b = ring[(i + 1) % ring.length];
		if (a.y <= p.y) {
			if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) w++;
		} else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) w--;
	}
	return w;
}

const insideNonzero = (rings: Pt[][], p: Pt) => rings.reduce((w, r) => w + winding(r, p), 0) !== 0;

/** Even-odd across every ring of a well-formed MultiPolygon (outers + holes). */
function insideMultiPolygon(mp: number[][][][], p: Pt): boolean {
	let inside = false;
	for (const poly of mp) {
		for (const ring of poly) {
			let hit = false;
			for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
				const [xi, yi] = ring[i], [xj, yj] = ring[j];
				if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) hit = !hit;
			}
			if (hit) inside = !inside;
		}
	}
	return inside;
}

function disagreementRate(points: Pt[], radius: number, step = 1) {
	const d = eraserSweptRegionPath(points, radius);
	const rings = ringsOf(d);
	assert.ok(rings.length > 0, 'swept region path produced no ring');
	const mp = eraserOutlinePolygon(points, radius) as unknown as number[][][][];
	assert.ok(mp && mp.length > 0, 'outline polygon produced nothing');

	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of points) {
		minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
		minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
	}
	const m = radius + 4;
	let differ = 0, covered = 0;
	for (let y = minY - m; y <= maxY + m; y += step) {
		for (let x = minX - m; x <= maxX + m; x += step) {
			// Sample off the grid the geometry snaps to, so a sample never lands
			// exactly on an edge where the two rules are allowed to disagree.
			const p = { x: x + 0.037, y: y + 0.041 };
			const a = insideNonzero(rings, p);
			const b = insideMultiPolygon(mp, p);
			if (a) covered++;
			if (a !== b) differ++;
		}
	}
	return { differ, covered };
}

describe('live fade stand-in geometry', () => {
	it('covers the same region the commit cuts, on a straight trail', () => {
		const pts = Array.from({ length: 20 }, (_, i) => ({ x: 40 + i * 12, y: 100 }));
		const { differ, covered } = disagreementRate(pts, 22);
		assert.ok(covered > 5000, `expected a substantial region, got ${covered}`);
		assert.equal(differ, 0);
	});

	it('covers the same region on a trail that curls back inside its own width', () => {
		// A tight S that folds the offset ring over itself several times — the
		// case the boolean union exists for, and the one a nonzero fill has to
		// resolve identically.
		const pts: Pt[] = [];
		for (let i = 0; i <= 60; i++) {
			const t = (i / 60) * Math.PI * 3;
			pts.push({ x: 120 + t * 22, y: 160 + Math.sin(t) * 55 });
		}
		const { differ, covered } = disagreementRate(pts, 30);
		assert.ok(covered > 20000, `expected a substantial region, got ${covered}`);
		assert.equal(differ, 0);
	});

	it('covers the same region on a trail that doubles straight back over itself', () => {
		const out = Array.from({ length: 25 }, (_, i) => ({ x: 60 + i * 10, y: 120 }));
		const back = Array.from({ length: 25 }, (_, i) => ({ x: 300 - i * 10, y: 128 }));
		const { differ, covered } = disagreementRate([...out, ...back], 26);
		assert.ok(covered > 8000, `expected a substantial region, got ${covered}`);
		assert.equal(differ, 0);
	});

	it('is a closed dot for a trail that never moved', () => {
		const d = eraserSweptRegionPath([{ x: 50, y: 50 }], 20);
		assert.match(d, /^M .* Z$/);
		const rings = ringsOf(d);
		assert.equal(rings.length, 1);
		assert.ok(insideNonzero(rings, { x: 50, y: 50 }));
		assert.ok(!insideNonzero(rings, { x: 50 + 25, y: 50 }));
	});
});
