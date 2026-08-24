import { describe, expect, it } from 'vitest';
import { backspaceAtStartOps, deleteAtEndOps, expandCaretToUnit } from './units.js';
import { divider, nest, page, para } from './testFixtures.js';

describe('units', () => {
	it('expandCaretToUnit returns null for missing ids and at edges', () => {
		const doc = page([para('a', 'ab')]);
		expect(
			expandCaretToUnit(doc, { anchor: { blockId: 'missing', offset: 0 }, head: { blockId: 'missing', offset: 0 } }, 'backward')
		).toBeNull();
		expect(
			expandCaretToUnit(doc, { anchor: { blockId: 'a', offset: 0 }, head: { blockId: 'a', offset: 0 } }, 'backward')
		).toBeNull();
		expect(
			expandCaretToUnit(doc, { anchor: { blockId: 'a', offset: 2 }, head: { blockId: 'a', offset: 2 } }, 'forward')
		).toBeNull();
		expect(
			expandCaretToUnit(doc, { anchor: { blockId: 'a', offset: 1 }, head: { blockId: 'a', offset: 1 } }, 'backward')
		).toEqual({
			anchor: { blockId: 'a', offset: 0 },
			head: { blockId: 'a', offset: 1 }
		});
	});

	it('backspaceAtStartOps / deleteAtEndOps no-op at parent edges and on missing ids', () => {
		const doc = page([para('a', 'a'), para('b', 'b'), divider('d')]);
		expect(backspaceAtStartOps(doc, 'a')).toEqual([]);
		expect(backspaceAtStartOps(doc, 'missing')).toEqual([]);
		expect(backspaceAtStartOps(doc, 'b')).toEqual([{ kind: 'merge-block', keepId: 'a', dropId: 'b' }]);
		expect(deleteAtEndOps(doc, 'd')).toEqual([]);
		expect(deleteAtEndOps(doc, 'missing')).toEqual([]);
		expect(deleteAtEndOps(doc, 'b')).toEqual([{ kind: 'delete-block', id: 'd' }]);
	});

	it('does not merge a nested first/last child with a DFS neighbor outside the parent', () => {
		const doc = page([para('z', 'z'), nest('c', [para('a', 'a'), para('b', 'b')]), para('y', 'y')]);
		expect(backspaceAtStartOps(doc, 'a')).toEqual([]);
		expect(deleteAtEndOps(doc, 'b')).toEqual([]);
		expect(backspaceAtStartOps(doc, 'b')).toEqual([{ kind: 'merge-block', keepId: 'a', dropId: 'b' }]);
		expect(deleteAtEndOps(doc, 'a')).toEqual([{ kind: 'merge-block', keepId: 'a', dropId: 'b' }]);
	});
});
