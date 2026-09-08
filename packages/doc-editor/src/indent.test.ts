import { apply } from '@shared-packages/doc-model';
import { describe, expect, it } from 'vitest';
import { codeTabOps, indentOps } from './indent.js';
import { code, item, page, para, table, row, cell } from './testFixtures.js';

describe('indentOps', () => {
	it('Tab increments indent on a paragraph; Shift+Tab clears it', () => {
		const src = page([para('p', 'ab')]);
		const live = { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 1 } };
		expect(indentOps(src, live, 1).ops).toEqual([{ kind: 'set-indent', id: 'p', indent: 1 }]);
		const indented = apply(src, { kind: 'set-indent', id: 'p', indent: 1 });
		expect(indentOps(indented, live, -1).ops).toEqual([{ kind: 'set-indent', id: 'p', indent: null }]);
	});

	it('indents every indentable block in a multi-block selection', () => {
		const src = page([para('a', 'a'), item('b', 'b'), para('c', 'c')]);
		const live = { anchor: { blockId: 'a', offset: 0 }, head: { blockId: 'c', offset: 1 } };
		expect(indentOps(src, live, 1).ops).toEqual([
			{ kind: 'set-indent', id: 'a', indent: 1 },
			{ kind: 'set-indent', id: 'b', indent: 1 },
			{ kind: 'set-indent', id: 'c', indent: 1 }
		]);
	});

	it('skips table cells and clamps at 8', () => {
		const src = page([
			table('t', [row('r', [cell('c1', 'x')])]),
			{ id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'z', marks: [] }], indent: 8 }
		]);
		const cellLive = { anchor: { blockId: 'c1', offset: 0 }, head: { blockId: 'c1', offset: 0 } };
		expect(indentOps(src, cellLive, 1).ops).toEqual([]);
		const paraLive = { anchor: { blockId: 'p', offset: 0 }, head: { blockId: 'p', offset: 0 } };
		expect(indentOps(src, paraLive, 1).ops).toEqual([]);
		expect(indentOps(src, paraLive, -1).ops).toEqual([{ kind: 'set-indent', id: 'p', indent: 7 }]);
	});
});

describe('codeTabOps', () => {
	it('inserts a tab at a collapsed caret in a code fence', () => {
		const src = page([code('c', 'ab')]);
		const live = { anchor: { blockId: 'c', offset: 1 }, head: { blockId: 'c', offset: 1 } };
		expect(codeTabOps(src, live, false)).toEqual({
			ops: [{ kind: 'insert-text', at: { blockId: 'c', offset: 1 }, text: '\t' }],
			selection: { anchor: { blockId: 'c', offset: 2 }, head: { blockId: 'c', offset: 2 } }
		});
	});

	it('Shift+Tab deletes a preceding tab or up to two spaces', () => {
		const tabbed = page([code('c', 'a\tb')]);
		const afterTab = { anchor: { blockId: 'c', offset: 2 }, head: { blockId: 'c', offset: 2 } };
		expect(codeTabOps(tabbed, afterTab, true)?.ops).toEqual([
			{
				kind: 'delete-range',
				range: {
					anchor: { blockId: 'c', offset: 1 },
					head: { blockId: 'c', offset: 2 }
				}
			}
		]);
		const spaced = page([code('c', 'a  b')]);
		const afterSpaces = { anchor: { blockId: 'c', offset: 3 }, head: { blockId: 'c', offset: 3 } };
		expect(codeTabOps(spaced, afterSpaces, true)?.ops).toEqual([
			{
				kind: 'delete-range',
				range: {
					anchor: { blockId: 'c', offset: 1 },
					head: { blockId: 'c', offset: 3 }
				}
			}
		]);
	});

	it('is a no-op on a paragraph (indentOps owns Tab there)', () => {
		const src = page([para('p', 'ab')]);
		const live = { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 1 } };
		expect(codeTabOps(src, live, false)).toBeNull();
	});
});
