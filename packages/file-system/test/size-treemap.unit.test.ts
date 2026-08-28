import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { layoutTreemap, formatSize, type TreemapInput } from '../src/ui/sizeTreemap.ts';

describe('size treemap', () => {
	it('area is proportional to bytes', () => {
		const items: TreemapInput[] = [
			{ id: 'a', name: 'a', size: 800, kind: 'file' },
			{ id: 'b', name: 'b', size: 200, kind: 'file' }
		];
		const rects = layoutTreemap(items, 400, 300);
		const area = (id: string) => {
			const r = rects.find((x) => x.id === id)!;
			return r.w * r.h;
		};
		const ratio = area('a') / area('b');
		assert.ok(ratio > 3.5 && ratio < 4.5, `4:1 bytes should give ~4:1 area, got ${ratio.toFixed(2)}`);
	});

	it('fills the canvas without overlapping', () => {
		const items: TreemapInput[] = Array.from({ length: 12 }, (_, i) => ({
			id: `n${i}`,
			name: `n${i}`,
			size: (i + 1) * 1000,
			kind: 'file' as const
		}));
		const W = 600, H = 400;
		const rects = layoutTreemap(items, W, H);
		const covered = rects.reduce((n, r) => n + r.w * r.h, 0);
		assert.ok(covered > W * H * 0.95, 'canvas is essentially filled');

		for (const r of rects) {
			assert.ok(r.x >= -0.01 && r.y >= -0.01, 'inside the canvas');
			assert.ok(r.x + r.w <= W + 0.01 && r.y + r.h <= H + 0.01, 'not overflowing');
		}
		// Pairwise overlap check at this size is cheap and catches layout bugs
		// that area-sum alone would miss.
		for (let i = 0; i < rects.length; i++) {
			for (let j = i + 1; j < rects.length; j++) {
				const a = rects[i]!, b = rects[j]!;
				const disjoint =
					a.x + a.w <= b.x + 0.01 || b.x + b.w <= a.x + 0.01 ||
					a.y + a.h <= b.y + 0.01 || b.y + b.h <= a.y + 0.01;
				assert.ok(disjoint, `${a.name} overlaps ${b.name}`);
			}
		}
	});

	it('keeps rectangles roughly square rather than slivers', () => {
		// The whole point of squarifying: a naive slice-and-dice makes thin
		// strips that cannot be read or clicked.
		const items: TreemapInput[] = Array.from({ length: 20 }, (_, i) => ({
			id: `s${i}`, name: `s${i}`, size: 500, kind: 'file' as const
		}));
		const rects = layoutTreemap(items, 500, 500);
		const worst = Math.max(...rects.map((r) => Math.max(r.w / r.h, r.h / r.w)));
		assert.ok(worst < 4, `worst aspect ratio should stay low, got ${worst.toFixed(2)}`);
	});

	it('nests children inside their folder and tags the group', () => {
		const items: TreemapInput[] = [
			{
				id: 'proj', name: 'MyProject', size: 1000, kind: 'folder', group: 'project',
				children: [
					{ id: 'pack1', name: 'pack', size: 700, kind: 'file', group: 'pack' },
					{ id: 'loose', name: 'loose.txt', size: 300, kind: 'file' }
				]
			}
		];
		const rects = layoutTreemap(items, 400, 400);
		const parent = rects.find((r) => r.id === 'proj')!;
		const pack = rects.find((r) => r.id === 'pack1');
		assert.equal(parent.group, 'project');
		assert.ok(pack, 'child laid out');
		assert.equal(pack!.group, 'pack', 'pack keeps its own group for styling');
		assert.equal(pack!.depth, 1);
		// Containment: a child must sit inside its parent's box.
		assert.ok(pack!.x >= parent.x - 0.01 && pack!.y >= parent.y - 0.01);
		assert.ok(pack!.x + pack!.w <= parent.x + parent.w + 0.01);
	});

	it('drops entries too small to see instead of drawing slivers', () => {
		const items: TreemapInput[] = [
			{ id: 'big', name: 'big', size: 10_000_000, kind: 'file' },
			{ id: 'tiny', name: 'tiny', size: 1, kind: 'file' }
		];
		const rects = layoutTreemap(items, 300, 200);
		assert.ok(rects.some((r) => r.id === 'big'));
		assert.equal(rects.find((r) => r.id === 'tiny'), undefined, 'unclickable rect omitted');
	});

	it('survives degenerate input', () => {
		assert.deepEqual(layoutTreemap([], 100, 100), []);
		assert.deepEqual(layoutTreemap([{ id: 'z', name: 'z', size: 0, kind: 'file' }], 100, 100), []);
		assert.deepEqual(layoutTreemap([{ id: 'a', name: 'a', size: 5, kind: 'file' }], 0, 0), []);
	});

	it('formats sizes readably', () => {
		assert.equal(formatSize(512), '512 B');
		assert.equal(formatSize(2048), '2 KB');
		assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
		assert.equal(formatSize(3 * 1024 * 1024 * 1024), '3.00 GB');
	});
});
