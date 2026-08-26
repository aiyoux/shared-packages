import { describe, it, expect } from 'vitest';
import { zoneFromY, zoneFromPoint, canonicalizeSiblingZone, resolveDrop } from './zones.js';

describe('treeDnd zones', () => {
	const rect = { top: 0, height: 100 };

	it('zoneFromY bands', () => {
		expect(zoneFromY(rect, 10)).toBe('before');
		expect(zoneFromY(rect, 50)).toBe('into');
		expect(zoneFromY(rect, 90)).toBe('after');
	});

	it('grid (icons) uses left/right instead of top/bottom', () => {
		const tile = { top: 0, left: 0, height: 100, width: 100 };
		const opts = { kind: 'file' as const, supportsSiblingOrder: true, layout: 'grid' as const };
		expect(zoneFromPoint(tile, { x: 10, y: 80 }, opts)).toBe('before');
		expect(zoneFromPoint(tile, { x: 49, y: 80 }, opts)).toBe('before');
		expect(zoneFromPoint(tile, { x: 60, y: 10 }, opts)).toBe('after');
		const folderOpts = { kind: 'folder' as const, supportsSiblingOrder: true, layout: 'grid' as const };
		expect(zoneFromPoint(tile, { x: 50, y: 10 }, folderOpts)).toBe('into');
		expect(zoneFromPoint(tile, { x: 10, y: 50 }, folderOpts)).toBe('before');
		expect(zoneFromPoint(tile, { x: 90, y: 50 }, folderOpts)).toBe('after');
	});

	it('ordered files use a 50/50 before-after split (never into)', () => {
		const opts = { kind: 'file' as const, supportsSiblingOrder: true };
		expect(zoneFromY(rect, 10, opts)).toBe('before');
		expect(zoneFromY(rect, 49, opts)).toBe('before');
		expect(zoneFromY(rect, 50, opts)).toBe('after');
		expect(zoneFromY(rect, 90, opts)).toBe('after');
	});

	it('ordered folders keep a middle into-band', () => {
		const opts = { kind: 'folder' as const, supportsSiblingOrder: true };
		expect(zoneFromY(rect, 10, opts)).toBe('before');
		expect(zoneFromY(rect, 50, opts)).toBe('into');
		expect(zoneFromY(rect, 90, opts)).toBe('after');
	});

	it('canonicalize collapses before(i) into after(i-1)', () => {
		expect(canonicalizeSiblingZone(1, 'before')).toEqual({ index: 0, zone: 'after' });
		expect(canonicalizeSiblingZone(0, 'before')).toEqual({ index: 0, zone: 'before' });
		expect(canonicalizeSiblingZone(2, 'after')).toEqual({ index: 2, zone: 'after' });
		expect(canonicalizeSiblingZone(2, 'into')).toEqual({ index: 2, zone: 'into' });
	});

	it('null zone does not commit', () => {
		const r = resolveDrop({
			dragIds: ['a'],
			target: { id: 'b', parentId: null, kind: 'folder' },
			zone: null,
			supportsSiblingOrder: true
		});
		expect(r.ok).toBe(false);
	});

	it('ordered before/after same parent', () => {
		const r = resolveDrop({
			dragIds: ['a'],
			target: { id: 'b', parentId: 'p', kind: 'file' },
			zone: 'before',
			supportsSiblingOrder: true
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.newParentId).toBe('p');
			expect(r.afterId).toBe('b');
			expect(r.mode).toBe('reorder');
		}
	});

	it('unordered rejects before/after', () => {
		const r = resolveDrop({
			dragIds: ['a'],
			target: { id: 'b', parentId: null, kind: 'file' },
			zone: 'before',
			supportsSiblingOrder: false
		});
		expect(r.ok).toBe(false);
	});

	it('into folder moves; cycle rejected', () => {
		const ok = resolveDrop({
			dragIds: ['a'],
			target: { id: 'folder', parentId: null, kind: 'folder' },
			zone: 'into',
			supportsSiblingOrder: true
		});
		expect(ok.ok).toBe(true);

		const cycle = resolveDrop({
			dragIds: ['folder'],
			target: { id: 'folder', parentId: null, kind: 'folder' },
			zone: 'into',
			supportsSiblingOrder: true
		});
		expect(cycle.ok).toBe(false);
		if (!cycle.ok) expect(cycle.reason).toBe('cycle');
	});

	it('descendant cycle via map', () => {
		const desc = new Map([['parent', new Set(['child'])]]);
		const r = resolveDrop({
			dragIds: ['parent'],
			target: { id: 'child', parentId: 'parent', kind: 'folder' },
			zone: 'into',
			supportsSiblingOrder: true,
			descendantIds: desc
		});
		expect(r.ok).toBe(false);
	});
});
