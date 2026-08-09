import { describe, it, expect } from 'vitest';
import { zoneFromY, resolveDrop } from './zones.js';

describe('treeDnd zones', () => {
	const rect = { top: 0, height: 100 };

	it('zoneFromY bands', () => {
		expect(zoneFromY(rect, 10)).toBe('before');
		expect(zoneFromY(rect, 50)).toBe('into');
		expect(zoneFromY(rect, 90)).toBe('after');
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
