import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBlock, plaintextOf } from '@shared-packages/kb-model';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { mapBeforeInput } from './beforeinput.js';
import { copyPayload, parseSlice, pasteOps, sliceBlocks, slicePlaintext } from './clipboard.js';
import {
	beginComposition,
	commitComposition,
	shouldProject,
	snapshotComposition
} from './composition.js';
import { dropTarget, gutterOrder, handleHeights, overlayBoxes } from './gutter.js';
import KbEditor from './KbEditor.svelte';
import { mapKeydown } from './keymap.js';
import { COL_ATTR, project, syncView } from './project.js';
import { rangeFromEndpoints, rangeFromSelection } from './selection.js';
import { slashOps } from './slash.js';
import { applyEditorOps, createEditorState, dispatchMany, setSelection } from './state.js';
import { callout, cell, page, para, row, table } from './testFixtures.js';
import { backspaceAtStartOps, deleteAtEndOps } from './units.js';
import type { Op } from '@shared-packages/kb-model';

function host(): HTMLDivElement {
	const el = document.createElement('div');
	el.contentEditable = 'true';
	document.body.append(el);
	return el;
}

function grid() {
	return page([
		table('t', [
			row('r1', [cell('c11', 'aa'), cell('c12', 'bb')]),
			row('r2', [cell('c21', 'cc'), cell('c22', 'dd')])
		]),
		para('z', 'zz')
	]);
}

function walkFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...walkFiles(full));
		else if (/\.(ts|svelte)$/.test(name)) out.push(full);
	}
	return out;
}

describe('N4 table editor', () => {
	it('projects stacked cell divs: no HTML table, no nested CE, rows omitted', () => {
		const el = host();
		project(el, grid());
		expect([...el.children].map((c) => c.getAttribute('data-block-id'))).toEqual([
			't',
			'c11',
			'c12',
			'c21',
			'c22',
			'z'
		]);
		expect(el.querySelector('[data-block-id="r1"]')).toBeNull();
		expect(el.querySelector('[data-block-id="c11"]')?.parentElement).toBe(el);
		expect(el.querySelector('[data-block-id="c11"]')?.tagName).toBe('DIV');
		expect(el.querySelector('[data-block-id="c11"]')?.getAttribute('data-parent-id')).toBe('r1');
		expect(el.querySelector('[data-block-id="c11"]')?.getAttribute(COL_ATTR)).toBe('0');
		expect(el.querySelector('[data-block-id="c12"]')?.getAttribute(COL_ATTR)).toBe('1');
		expect(el.querySelector('[data-block-id="c21"]')?.getAttribute('data-parent-id')).toBe('r2');
		expect(el.querySelector('[data-block-id="t"]')?.getAttribute('data-block-type')).toBe('table');
		expect(el.querySelector('table')).toBeNull();
		expect(el.querySelector('tr')).toBeNull();
		expect(el.querySelector('td')).toBeNull();
		expect(el.querySelector('th')).toBeNull();
		expect(el.querySelectorAll('[contenteditable]').length).toBe(0);
		for (const cellEl of el.querySelectorAll('[data-block-type="table_cell"]')) {
			expect(cellEl.getAttribute('contenteditable')).not.toBe('true');
		}
		expect(getComputedStyle(el).display).not.toBe('grid');
		el.remove();
	});

	it('projects table cells with column width and row attributes for multi-column grid', () => {
		const el = host();
		project(el, grid());
		const c11 = el.querySelector('[data-block-id="c11"]') as HTMLElement;
		const c12 = el.querySelector('[data-block-id="c12"]') as HTMLElement;
		const c21 = el.querySelector('[data-block-id="c21"]') as HTMLElement;
		expect(c11.getAttribute('data-cols')).toBe('2');
		expect(c11.getAttribute('data-row')).toBe('0');
		expect(c11.style.width).toBe('calc(50%)');
		expect(c12.getAttribute('data-cols')).toBe('2');
		expect(c12.getAttribute('data-row')).toBe('0');
		expect(c21.getAttribute('data-row')).toBe('1');
		el.remove();
	});

	it('empty cell has a persistent empty Text node and no magic br', () => {
		const el = host();
		project(el, page([table('t', [row('r1', [cell('c11', '')])])]));
		const cellEl = el.querySelector('[data-block-id="c11"]') as HTMLElement;
		const text = [...cellEl.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		expect(text).toBeTruthy();
		expect(text.data).toBe('');
		text.data = '한';
		expect(cellEl.querySelector('br')).toBeNull();
		el.remove();
	});

	it('gutter handles table as single block without row handles or cell overlay rails', () => {
		const el = host();
		project(el, grid());
		const boxes = overlayBoxes(el);
		expect(boxes).toEqual([]);
		expect(gutterOrder(grid()).map((b) => b.id)).toEqual(['t', 'z']);
		el.remove();
	});

	it('table handle height spans the full table from first to last cell', () => {
		function rect(top: number, height: number, left = 0, width = 40): DOMRect {
			return {
				x: left,
				y: top,
				top,
				left,
				bottom: top + height,
				right: left + width,
				width,
				height,
				toJSON() {
					return this;
				}
			};
		}
		const el = host();
		project(el, grid());
		const c11 = el.querySelector('[data-block-id="c11"]') as HTMLElement;
		const c22 = el.querySelector('[data-block-id="c22"]') as HTMLElement;
		c11.getBoundingClientRect = () => rect(100, 20);
		c22.getBoundingClientRect = () => rect(140, 20);
		Object.defineProperty(c11, 'offsetHeight', { configurable: true, value: 20 });
		Object.defineProperty(c22, 'offsetHeight', { configurable: true, value: 20 });
		const heights = handleHeights(el, grid());
		expect(heights.t).toBe(60);
		el.remove();
	});

	it('drops onto cells or rows are noop; table after is page-level', () => {
		const doc = grid();
		expect(dropTarget(doc, 'z', 'c11', 'after')).toBe('noop');
		expect(dropTarget(doc, 'z', 'r1', 'after')).toBe('noop');
		expect(dropTarget(doc, 'c11', 'z', 'after')).toBe('noop');
		expect(dropTarget(doc, 'z', 't', 'before')).toEqual({ afterId: null, parentId: null });
		expect(dropTarget(doc, 't', 'z', 'after')).toEqual({ afterId: 'z', parentId: null });
		expect(dropTarget(doc, 't', 'z', 'before')).toBe('noop');
	});

	it('does not drop a table into a callout', () => {
		const doc = page([
			table('t', [row('r1', [cell('c11', 'aa')])]),
			callout('c', [para('n', 'in')])
		]);
		expect(dropTarget(doc, 't', 'c', 'after')).toBe('noop');
		expect(dropTarget(doc, 't', 'n', 'after')).toBe('noop');
	});

	it('Tab moves row-major; last cell Tab inserts a row', () => {
		const state = {
			...createEditorState(grid()),
			selection: { anchor: { blockId: 'c11', offset: 2 }, head: { blockId: 'c11', offset: 2 } }
		};
		const tab = mapKeydown(
			state,
			{ key: 'Tab', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
			state.selection
		);
		expect(tab.preventDefault).toBe(true);
		expect(tab.ops).toEqual([]);
		expect(tab.selection?.anchor.blockId).toBe('c12');

		const last = {
			...state,
			selection: { anchor: { blockId: 'c22', offset: 2 }, head: { blockId: 'c22', offset: 2 } }
		};
		const atEnd = mapKeydown(
			last,
			{ key: 'Tab', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
			last.selection
		);
		expect(atEnd.ops[0]?.kind).toBe('insert-table-row');
		const next = dispatchMany(last, atEnd.ops);
		const tableBlock = findBlock(next.page, 't');
		expect(tableBlock?.type).toBe('table');
		if (tableBlock?.type === 'table') expect(tableBlock.children).toHaveLength(3);
		expect(atEnd.selection?.anchor.blockId).not.toBe('c22');
		expect(next.selection.anchor.blockId).toBe(atEnd.selection?.anchor.blockId);
		if (tableBlock?.type === 'table') {
			expect(next.selection.anchor.blockId).toBe(tableBlock.children[2]?.children[0]?.id);
		}
	});

	it('Enter moves to the cell below, or inserts a row in the last row', () => {
		const state = {
			...createEditorState(grid()),
			selection: { anchor: { blockId: 'c11', offset: 2 }, head: { blockId: 'c11', offset: 2 } }
		};
		const enter = mapKeydown(
			state,
			{ key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
			state.selection
		);
		expect(enter.preventDefault).toBe(true);
		expect(enter.ops).toEqual([]);
		expect(enter.selection?.anchor.blockId).toBe('c21');
		expect(enter.ops.some((op) => op.kind === 'split-block')).toBe(false);

		const last = {
			...state,
			selection: { anchor: { blockId: 'c21', offset: 0 }, head: { blockId: 'c21', offset: 0 } }
		};
		const atEnd = mapBeforeInput(last, { inputType: 'insertParagraph', data: null }, last.selection);
		expect(atEnd.ops[0]?.kind).toBe('insert-table-row');
		expect(atEnd.ops.some((op) => op.kind === 'split-block')).toBe(false);
		expect(() => dispatchMany(last, atEnd.ops)).not.toThrow();

		const lastCol = {
			...state,
			selection: { anchor: { blockId: 'c22', offset: 2 }, head: { blockId: 'c22', offset: 2 } }
		};
		const enterLast = mapKeydown(
			lastCol,
			{ key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
			lastCol.selection
		);
		const afterEnter = dispatchMany(lastCol, enterLast.ops);
		expect(afterEnter.selection.anchor.blockId).toBe(enterLast.selection?.anchor.blockId);
		const t = findBlock(afterEnter.page, 't');
		if (t?.type === 'table') {
			expect(afterEnter.selection.anchor.blockId).toBe(t.children[2]?.children[1]?.id);
		}
	});

	it('blockFocus on table chrome deletes the whole table', () => {
		let state = createEditorState(grid());
		state = {
			...state,
			selection: { anchor: { blockId: 't', offset: 0 }, head: { blockId: 't', offset: 0 } },
			blockFocus: 't'
		};
		const result = mapBeforeInput(state, { inputType: 'deleteContentBackward', data: null }, state.selection);
		expect(result.ops).toEqual([{ kind: 'delete-block', id: 't' }]);
		state = dispatchMany(state, result.ops);
		expect(findBlock(state.page, 't')).toBeUndefined();
		expect(state.page.blocks.map((b) => b.id)).toEqual(['z']);
	});

	it('blockFocus on a row handle deletes the row, last row drops the table', () => {
		let state = createEditorState(grid());
		state = {
			...state,
			selection: { anchor: { blockId: 'r1', offset: 0 }, head: { blockId: 'r1', offset: 0 } },
			blockFocus: 'r1'
		};
		const result = mapBeforeInput(state, { inputType: 'deleteContentBackward', data: null }, state.selection);
		expect(result.ops).toEqual([{ kind: 'delete-table-row', tableId: 't', rowId: 'r1' }]);
		state = dispatchMany(state, result.ops);
		const tableBlock = findBlock(state.page, 't');
		expect(tableBlock?.type).toBe('table');
		if (tableBlock?.type === 'table') expect(tableBlock.children.map((r) => r.id)).toEqual(['r2']);

		state = {
			...state,
			selection: { anchor: { blockId: 'r2', offset: 0 }, head: { blockId: 'r2', offset: 0 } },
			blockFocus: 'r2'
		};
		const last = mapBeforeInput(state, { inputType: 'deleteContentBackward', data: null }, state.selection);
		expect(last.ops).toEqual([{ kind: 'delete-block', id: 't' }]);
	});

	it('clipboard copies a rectangular cell region as a table', () => {
		const state = createEditorState(grid());
		const live = { anchor: { blockId: 'c11', offset: 1 }, head: { blockId: 'c22', offset: 1 } };
		const sliced = sliceBlocks(state.page, live);
		expect(sliced).toHaveLength(1);
		expect(sliced[0]?.type).toBe('table');
		if (sliced[0]?.type === 'table') {
			expect(sliced[0].children).toHaveLength(2);
			expect(sliced[0].children[0]?.children).toHaveLength(2);
		}
		expect(slicePlaintext(state.page, live)).toBe('a\tbb\ncc\td');
		const payload = copyPayload({ ...state, selection: live }, live);
		expect(payload?.plain).toBe('a\tbb\ncc\td');
		expect(payload?.json).toContain('table_cell');
	});

	it('same-cell copy pastes as a paragraph outside the grid; row copy wraps as a table', () => {
		const src = createEditorState(grid());
		const cellLive = { anchor: { blockId: 'c11', offset: 0 }, head: { blockId: 'c11', offset: 2 } };
		const sliced = sliceBlocks(src.page, cellLive);
		expect(sliced[0]?.type).toBe('paragraph');
		const cellPayload = copyPayload({ ...src, selection: cellLive }, cellLive);
		const dest = createEditorState(page([para('z', 'zz')]));
		const at = { anchor: { blockId: 'z', offset: 2 }, head: { blockId: 'z', offset: 2 } };
		const cellOps = pasteOps(dest, at, { json: cellPayload!.json });
		expect(cellOps.every((op) => op.kind !== 'insert-block' || op.block.type !== 'table_cell')).toBe(true);
		expect(() => dispatchMany(dest, cellOps)).not.toThrow();
		const pasted = dispatchMany(dest, cellOps);
		expect(pasted.page.blocks.some((b) => plaintextOf(b).includes('aa'))).toBe(true);

		const rowPayload = copyPayload(
			{
				...src,
				selection: { anchor: { blockId: 'r1', offset: 0 }, head: { blockId: 'r1', offset: 0 } },
				blockFocus: 'r1'
			},
			{ anchor: { blockId: 'r1', offset: 0 }, head: { blockId: 'r1', offset: 0 } }
		);
		const rowBlocks = parseSlice(rowPayload!.json);
		expect(rowBlocks?.[0]?.type).toBe('table');
		const rowOps = pasteOps(dest, at, { json: rowPayload!.json });
		expect(rowOps.every((op) => op.kind !== 'insert-block' || op.block.type !== 'table_row')).toBe(true);
		expect(() => dispatchMany(dest, rowOps)).not.toThrow();

		const mixed = { anchor: { blockId: 'c11', offset: 0 }, head: { blockId: 'z', offset: 1 } };
		const mixedOps = pasteOps(dest, at, { json: copyPayload({ ...src, selection: mixed }, mixed)!.json });
		expect(
			mixedOps.every(
				(op) => op.kind !== 'insert-block' || (op.block.type !== 'table_cell' && op.block.type !== 'table_row')
			)
		).toBe(true);
		expect(() => dispatchMany(dest, mixedOps)).not.toThrow();
	});

	it('paste of a table slice into a cell fills rectangularly without split-block', () => {
		const src = createEditorState(grid());
		const live = { anchor: { blockId: 'c11', offset: 0 }, head: { blockId: 'c12', offset: 2 } };
		const payload = copyPayload({ ...src, selection: live }, live);
		const dest = createEditorState(grid());
		const at = { anchor: { blockId: 'c21', offset: 2 }, head: { blockId: 'c21', offset: 2 } };
		const ops = pasteOps(dest, at, { json: payload!.json });
		expect(ops.some((op) => op.kind === 'split-block')).toBe(false);
		expect(ops.some((op) => op.kind === 'insert-block')).toBe(false);
		const next = dispatchMany(dest, ops);
		expect(plaintextOf(findBlock(next.page, 'c21')!)).toBe('ccaa');
		expect(plaintextOf(findBlock(next.page, 'c22')!)).toBe('bb');
	});

	it('TSV paste into a cell fills the grid; newlines in a cell do not split', () => {
		const dest = createEditorState(grid());
		const at = { anchor: { blockId: 'c11', offset: 2 }, head: { blockId: 'c11', offset: 2 } };
		const ops = pasteOps(dest, at, { plain: 'X\tY\nP\tQ' });
		expect(ops.some((op) => op.kind === 'split-block')).toBe(false);
		const next = dispatchMany(dest, ops);
		expect(plaintextOf(findBlock(next.page, 'c11')!)).toBe('aaX');
		expect(plaintextOf(findBlock(next.page, 'c12')!)).toBe('Y');
		expect(plaintextOf(findBlock(next.page, 'c21')!)).toBe('P');
		expect(plaintextOf(findBlock(next.page, 'c22')!)).toBe('Q');
	});

	it('slash /table inserts a default grid, not convert-block', () => {
		const ops = slashOps('p', '/table');
		expect(ops?.some((op) => op.kind === 'convert-block')).toBe(false);
		expect(ops?.[0]?.kind).toBe('insert-block');
		if (ops?.[0]?.kind === 'insert-block') {
			expect(ops[0].block.type).toBe('table');
			if (ops[0].block.type === 'table') {
				expect(ops[0].block.children).toHaveLength(2);
				expect(ops[0].block.children[0]?.children).toHaveLength(3);
			}
		}
		expect(ops?.[1]).toMatchObject({ kind: 'delete-block', id: 'p' });
		let state = createEditorState(page([para('p', '/table')]));
		state = dispatchMany(state, slashOps('p', '/table', state.page)!);
		expect(state.page.blocks).toHaveLength(1);
		expect(state.page.blocks[0]?.type).toBe('table');
	});

	it('slash convert in a cell does not convert-block', () => {
		const doc = page([table('t', [row('r1', [cell('c11', '/h1')])]), para('z', 'zz')]);
		let state = {
			...createEditorState(doc),
			selection: { anchor: { blockId: 'c11', offset: 3 }, head: { blockId: 'c11', offset: 3 } }
		};
		const result = mapBeforeInput(state, { inputType: 'insertText', data: ' ' }, state.selection);
		expect(result.ops.some((op) => op.kind === 'convert-block')).toBe(false);
		expect(() => dispatchMany(state, result.ops)).not.toThrow();
		state = dispatchMany(state, result.ops);
		expect(findBlock(state.page, 'c11')?.type).toBe('table_cell');
		expect(plaintextOf(findBlock(state.page, 'c11')!)).toBe('/h1 ');
	});

	it('does not merge adjacent cells on Backspace/Delete at edges', () => {
		const doc = grid();
		expect(backspaceAtStartOps(doc, 'c12')).toEqual([]);
		expect(deleteAtEndOps(doc, 'c11')).toEqual([]);
		expect(backspaceAtStartOps(doc, 'c11')).toEqual([]);
	});

	it('IME freeze inside a cell: no re-project, then one insert-text on the cell', () => {
		const el = host();
		const doc = grid();
		project(el, doc);
		let state = {
			...createEditorState(doc),
			selection: { anchor: { blockId: 'c11', offset: 2 }, head: { blockId: 'c11', offset: 2 } }
		};
		state = beginComposition(state);
		expect(shouldProject(state)).toBe(false);
		const spy = vi.spyOn(el, 'replaceChildren');
		syncView(el, state);
		expect(spy).not.toHaveBeenCalled();
		expect(el.querySelector('[data-block-id="c11"]')?.getAttribute('data-parent-id')).toBe('r1');
		const frozen = mapBeforeInput(
			state,
			{ inputType: 'insertCompositionText', data: 'あ', isComposing: true },
			state.selection
		);
		expect(frozen.preventDefault).toBe(false);
		expect(frozen.ops).toEqual([]);
		const snap = snapshotComposition(state, state.selection);
		const { ops } = commitComposition(state, snap, 'あ');
		expect(ops).toEqual([{ kind: 'insert-text', at: { blockId: 'c11', offset: 2 }, text: 'あ' }]);
		state = dispatchMany({ ...state, composing: false }, ops);
		expect(plaintextOf(findBlock(state.page, 'c11')!)).toBe('aaあ');
		const follow = mapKeydown(
			{ ...state, justCommittedComposition: true },
			{ key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
			{ anchor: { blockId: 'c11', offset: 3 }, head: { blockId: 'c11', offset: 3 } }
		);
		expect(follow.preventDefault).toBe(true);
		expect(follow.ops).toEqual([]);
		expect(follow.selection).toBeUndefined();
		spy.mockRestore();
		el.remove();
	});

	it('cross-cell drag-select maps distinct cell ids', () => {
		const el = host();
		project(el, grid());
		const a = el.querySelector('[data-block-id="c11"]') as HTMLElement;
		const b = el.querySelector('[data-block-id="c22"]') as HTMLElement;
		const tA = [...a.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		const tB = [...b.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		const range = rangeFromEndpoints(el, tA, 1, tB, 1);
		expect(range?.anchor.blockId).toBe('c11');
		expect(range?.head.blockId).toBe('c22');
		expect(range?.anchor.blockId !== range?.head.blockId).toBe(true);
		el.remove();
	});

	it('cell → paragraph after the table does not merge text', () => {
		const state = createEditorState(grid());
		const live = { anchor: { blockId: 'c22', offset: 1 }, head: { blockId: 'z', offset: 1 } };
		const result = mapBeforeInput(state, { inputType: 'deleteContentBackward', data: null }, live);
		expect(result.ops).toEqual([{ kind: 'delete-range', range: live }]);
		const next = dispatchMany(state, result.ops);
		expect(plaintextOf(findBlock(next.page, 'c22')!)).toBe('d');
		expect(plaintextOf(findBlock(next.page, 'z')!)).toBe('z');
		expect(next.page.blocks.map((b) => b.id)).toEqual(['t', 'z']);
	});

	it('KbEditor: one host, no <table>, overlay in the gutter, cross-cell select, no cell CE', async () => {
		let state = createEditorState(grid());
		const { container, unmount } = render(KbEditor, {
			props: {
				state,
				editable: true,
				onDispatch: (op: Op | Op[]) => {
					state = applyEditorOps(state, op);
				}
			}
		});
		await tick();
		const kbHost = container.querySelector('[data-testid="kb-host"]') as HTMLElement;
		const gutter = container.querySelector('[data-testid="kb-gutter"]') as HTMLElement;
		expect(kbHost.getAttribute('contenteditable')).toBe('true');
		expect(kbHost.querySelectorAll('[contenteditable="true"]').length).toBe(0);
		expect(kbHost.querySelector('table')).toBeNull();
		expect(kbHost.querySelector('tr')).toBeNull();
		expect(kbHost.querySelector('td')).toBeNull();
		for (const cellEl of kbHost.querySelectorAll('[data-block-type="table_cell"]')) {
			expect(cellEl.getAttribute('contenteditable')).not.toBe('true');
		}
		expect(kbHost.querySelector('[data-block-id="r1"]')).toBeNull();
		expect(gutter.querySelector('[data-block-id="r1"]')).toBeNull();
		expect(gutter.querySelector('[data-block-id="t"]')).toBeTruthy();
		expect(gutter.querySelector('[data-block-id="c11"]')).toBeNull();
		const overlays = [...container.querySelectorAll('[data-testid="kb-gutter-overlay"]')];
		expect(overlays.length).toBe(0);
		const a = kbHost.querySelector('[data-block-id="c11"]') as HTMLElement;
		const z = kbHost.querySelector('[data-block-id="z"]') as HTMLElement;
		const tA = [...a.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		const tZ = [...z.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		const mapped = rangeFromEndpoints(kbHost, tA, 1, tZ, 1);
		expect(mapped?.anchor.blockId).toBe('c11');
		expect(mapped?.head.blockId).toBe('z');
		unmount();
	});

	it('KbEditor onDispatch-only: Tab moves caret; last-row Enter keeps the column', async () => {
		let state = setSelection(createEditorState(grid()), {
			anchor: { blockId: 'c11', offset: 2 },
			head: { blockId: 'c11', offset: 2 }
		});
		const { container, unmount } = render(KbEditor, {
			props: {
				state,
				editable: true,
				onDispatch: (op: Op | Op[]) => {
					state = applyEditorOps(state, op);
				}
			}
		});
		await tick();
		const kbHost = container.querySelector('[data-testid="kb-host"]') as HTMLElement;
		kbHost.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
		await tick();
		expect(rangeFromSelection(kbHost)?.anchor.blockId).toBe('c12');

		unmount();

		state = setSelection(createEditorState(grid()), {
			anchor: { blockId: 'c22', offset: 2 },
			head: { blockId: 'c22', offset: 2 }
		});
		const second = render(KbEditor, {
			props: {
				state,
				editable: true,
				onDispatch: (op: Op | Op[]) => {
					state = applyEditorOps(state, op);
				}
			}
		});
		await tick();
		const host2 = second.container.querySelector('[data-testid="kb-host"]') as HTMLElement;
		host2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		await tick();
		const caret = rangeFromSelection(host2);
		expect(caret?.anchor.blockId).not.toBe('c22');
		const dest = host2.querySelector(`[data-block-id="${caret?.anchor.blockId}"]`) as HTMLElement;
		expect(dest?.getAttribute('data-col')).toBe('1');
		expect(dest?.getAttribute('data-parent-id')).not.toBe('r2');
		second.unmount();
	});

	it('onDispatch-only last-cell Tab lands on the first cell of the new row', async () => {
		let state = setSelection(createEditorState(grid()), {
			anchor: { blockId: 'c22', offset: 2 },
			head: { blockId: 'c22', offset: 2 }
		});
		const onDispatch = (op: Op | Op[]) => {
			state = applyEditorOps(state, op);
		};
		const { container, rerender, unmount } = render(KbEditor, {
			props: { state, editable: true, onDispatch }
		});
		await tick();
		const kbHost = container.querySelector('[data-testid="kb-host"]') as HTMLElement;
		kbHost.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
		await rerender({ state, editable: true, onDispatch });
		await tick();
		const hostAfter = container.querySelector('[data-testid="kb-host"]') as HTMLElement;
		const caret = rangeFromSelection(hostAfter);
		expect(caret?.anchor.blockId).not.toBe('c22');
		const dest = hostAfter.querySelector(`[data-block-id="${caret?.anchor.blockId}"]`) as HTMLElement;
		expect(dest?.getAttribute('data-col')).toBe('0');
		expect(dest?.getAttribute('data-parent-id')).not.toBe('r2');
		unmount();
	});

	it('source grep: no HTML <table> constructor and no per-cell contenteditable', () => {
		const srcDir = dirname(fileURLToPath(import.meta.url));
		for (const file of walkFiles(srcDir)) {
			if (file.endsWith('.test.ts')) continue;
			const text = readFileSync(file, 'utf8');
			expect(text, file).not.toMatch(/createElement\(\s*['"]table['"]\s*\)/);
			expect(text, file).not.toMatch(/<table[\s>]/i);
			expect(text, file).not.toMatch(/['"]td['"]|['"]tr['"]|['"]th['"]/);
			if (file.endsWith('KbEditor.svelte')) {
				expect(text).not.toMatch(/\.kb-host\s*\{[^}]*display:\s*grid/s);
			}
		}
	});

	it('typing in a cell is insert-text on that cell id', () => {
		let state = {
			...createEditorState(grid()),
			selection: { anchor: { blockId: 'c12', offset: 2 }, head: { blockId: 'c12', offset: 2 } }
		};
		const result = mapBeforeInput(state, { inputType: 'insertText', data: 'X' }, state.selection);
		expect(result.ops).toEqual([{ kind: 'insert-text', at: { blockId: 'c12', offset: 2 }, text: 'X' }]);
		state = dispatchMany(state, result.ops);
		expect(plaintextOf(findBlock(state.page, 'c12')!)).toBe('bbX');
	});

	it('Shift-Tab moves to the previous cell', () => {
		const state = {
			...createEditorState(grid()),
			selection: { anchor: { blockId: 'c21', offset: 0 }, head: { blockId: 'c21', offset: 0 } }
		};
		const result = mapKeydown(
			state,
			{ key: 'Tab', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false },
			state.selection
		);
		expect(result.selection?.anchor.blockId).toBe('c12');
	});
});
