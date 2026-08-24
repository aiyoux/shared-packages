import { findBlock, plaintextOf, visibleOrder } from '@shared-packages/kb-model';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { mapBeforeInput } from './beforeinput.js';
import { pasteOps, remapBlock, serializeSlice } from './clipboard.js';
import {
	beginComposition,
	commitComposition,
	shouldProject,
	snapshotComposition
} from './composition.js';
import { dropTarget, overlayBoxes } from './gutter.js';
import KbEditor from './KbEditor.svelte';
import { project, syncView } from './project.js';
import { clampPoint } from './range.js';
import { rangeFromEndpoints } from './selection.js';
import { slashOps } from './slash.js';
import { applyEditorOps, createEditorState, dispatch, dispatchMany } from './state.js';
import { callout, page, para, toggle } from './testFixtures.js';
import { backspaceAtStartOps } from './units.js';
import type { Op } from '@shared-packages/kb-model';

function host(): HTMLDivElement {
	const el = document.createElement('div');
	el.contentEditable = 'true';
	document.body.append(el);
	return el;
}

describe('N2 callout/toggle editor', () => {
	it('projects a flat host: parent-id/depth, no nested CE, no ul/ol/table', () => {
		const el = host();
		project(el, page([callout('c', [para('n', 'in'), para('m', '')]), para('z', 'Z')]));
		expect([...el.children].map((c) => c.getAttribute('data-block-id'))).toEqual(['c', 'n', 'm', 'z']);
		expect(el.querySelector('[data-block-id="c"]')?.parentElement).toBe(el);
		expect(el.querySelector('[data-block-id="n"]')?.parentElement).toBe(el);
		expect(el.querySelector('[data-block-id="n"]')?.getAttribute('data-parent-id')).toBe('c');
		expect(el.querySelector('[data-block-id="n"]')?.getAttribute('data-depth')).toBe('1');
		expect(el.querySelector('[data-block-id="z"]')?.getAttribute('data-parent-id')).toBeNull();
		expect(el.querySelector('[data-block-id="c"]')?.querySelector('[data-block-id]')).toBeNull();
		expect(el.querySelectorAll('[contenteditable]').length).toBe(0);
		expect(el.querySelector('ul')).toBeNull();
		expect(el.querySelector('ol')).toBeNull();
		expect(el.querySelector('table')).toBeNull();
		el.remove();
	});

	it('omits closed-toggle children from the host', () => {
		const el = host();
		const doc = page([toggle('t', [para('h', 'hid')], false), para('z', 'Z')]);
		expect(visibleOrder(doc).map((b) => b.id)).toEqual(['t', 'z']);
		project(el, doc);
		expect([...el.children].map((c) => c.getAttribute('data-block-id'))).toEqual(['t', 'z']);
		expect(el.querySelector('[data-block-id="h"]')).toBeNull();
		expect(clampPoint(doc, { blockId: 'h', offset: 1 })).toEqual({ blockId: 't', offset: 0 });
		el.remove();
	});

	it('empty child click+type: persistent empty Text node under the child, not the chrome', () => {
		const el = host();
		project(el, page([callout('c', [para('n', '')])]));
		const child = el.querySelector('[data-block-id="n"]') as HTMLElement;
		const text = [...child.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		expect(text).toBeTruthy();
		expect(text.data).toBe('');
		text.data = 'A';
		expect(child.querySelector('br')).toBeNull();
		expect(el.querySelector('[data-block-id="c"]')?.contains(child)).toBe(false);
		el.remove();
	});

	it('gutter overlay is column-width, pointer-events none, and does not cover the host', () => {
		const el = host();
		project(el, page([callout('c', [para('n', 'in'), para('m', 'mm')]), para('z', 'Z')]));
		const boxes = overlayBoxes(el);
		expect(boxes.map((b) => b.parentId)).toEqual(['c']);

		const wrap = document.createElement('div');
		wrap.style.display = 'flex';
		const gutter = document.createElement('div');
		gutter.className = 'kb-gutter';
		gutter.contentEditable = 'false';
		gutter.style.position = 'relative';
		gutter.style.flex = '0 0 1.25rem';
		gutter.style.width = '1.25rem';
		const overlay = document.createElement('div');
		overlay.dataset.testid = 'kb-gutter-overlay';
		overlay.style.position = 'absolute';
		overlay.style.left = '0';
		overlay.style.width = '100%';
		overlay.style.pointerEvents = 'none';
		gutter.append(overlay);
		wrap.append(gutter, el);
		document.body.append(wrap);
		expect(el.contains(overlay)).toBe(false);
		expect(gutter.contains(overlay)).toBe(true);
		expect(overlay.style.pointerEvents).toBe('none');
		expect(overlay.style.width).toBe('100%');
		wrap.remove();
	});

	it('drop onto callout chrome after prepends inside; child drop keeps parentId', () => {
		const doc = page([callout('c', [para('n', 'in')]), para('z', 'Z')]);
		expect(dropTarget(doc, 'z', 'c', 'after')).toEqual({ afterId: null, parentId: 'c' });
		expect(dropTarget(doc, 'z', 'c', 'before')).toEqual({ afterId: null, parentId: null });
		expect(dropTarget(doc, 'z', 'n', 'after')).toEqual({ afterId: 'n', parentId: 'c' });
		expect(dropTarget(doc, 'c', 'n', 'after')).toBe('noop');
	});

	it('slash /callout and /toggle insert+move, not convert', () => {
		const calloutOps = slashOps('p', '/callout');
		expect(calloutOps?.some((op) => op.kind === 'convert-block')).toBe(false);
		expect(calloutOps?.[0]?.kind).toBe('insert-block');
		expect(calloutOps?.[1]?.kind).toBe('move-block');
		if (calloutOps?.[0]?.kind === 'insert-block') {
			expect(calloutOps[0].block.type).toBe('callout');
		}
		if (calloutOps?.[1]?.kind === 'move-block') {
			expect(calloutOps[1]).toMatchObject({ id: 'p', afterId: null });
			expect(calloutOps[1].parentId).toBeTruthy();
		}

		let state = createEditorState(page([para('p', '/callout')]));
		state = dispatchMany(state, slashOps('p', '/callout', state.page)!);
		expect(state.page.blocks).toHaveLength(1);
		expect(state.page.blocks[0].type).toBe('callout');
		const kids = state.page.blocks[0].type === 'callout' ? state.page.blocks[0].children : [];
		expect(kids.map((b) => b.id)).toEqual(['p']);
		expect(plaintextOf(kids[0])).toBe('');

		const toggleOps = slashOps('q', '/toggle');
		expect(toggleOps?.some((op) => op.kind === 'convert-block')).toBe(false);
		expect(toggleOps?.[0]?.kind).toBe('insert-block');
		if (toggleOps?.[0]?.kind === 'insert-block') expect(toggleOps[0].block.type).toBe('toggle');
	});

	it('space after /callout wraps via insert+move', () => {
		let state = createEditorState(page([para('p', '/callout')]));
		state = {
			...state,
			selection: { anchor: { blockId: 'p', offset: 8 }, head: { blockId: 'p', offset: 8 } }
		};
		const result = mapBeforeInput(state, { inputType: 'insertText', data: ' ' }, state.selection);
		expect(result.ops.some((op) => op.kind === 'convert-block')).toBe(false);
		expect(result.ops[0]?.kind).toBe('insert-block');
		state = dispatchMany(state, result.ops);
		expect(state.page.blocks[0].type).toBe('callout');
	});

	it('Backspace-at-0 unwraps an empty first child and merges a nonempty only child', () => {
		const empty = page([para('before', 'xx'), callout('c', [para('n', '')]), para('z', 'Z')]);
		const unwrap = backspaceAtStartOps(empty, 'n');
		expect(unwrap[0]).toMatchObject({ kind: 'move-block', id: 'n' });
		expect(unwrap.some((op) => op.kind === 'delete-block' && op.id === 'c')).toBe(true);
		let state = createEditorState(empty);
		state = dispatchMany(state, unwrap);
		expect(state.page.blocks.map((b) => b.id)).toEqual(['before', 'n', 'z']);
		expect(findBlock(state.page, 'c')).toBeUndefined();

		const only = page([para('before', 'xx'), callout('c', [para('n', 'yy')])]);
		const merge = backspaceAtStartOps(only, 'n');
		expect(merge.map((op) => op.kind)).toEqual(['move-block', 'merge-block', 'delete-block']);
		state = dispatchMany(createEditorState(only), merge);
		expect(state.page.blocks.map((b) => b.id)).toEqual(['before']);
		expect(plaintextOf(state.page.blocks[0])).toBe('xxyy');
	});

	it('does not unwrap a nonempty first child that still has siblings', () => {
		const doc = page([para('z', 'z'), callout('c', [para('a', 'a'), para('b', 'b')])]);
		expect(backspaceAtStartOps(doc, 'a')).toEqual([]);
	});

	it('remapBlock walks children and remaps child ids', () => {
		const src = callout('c', [para('n', 'in'), para('m', 'mm')]);
		const next = remapBlock(src);
		expect(next.id).not.toBe('c');
		expect(next.type).toBe('callout');
		const kids = next.type === 'callout' ? next.children : [];
		expect(kids.map((b) => b.id)).not.toEqual(['n', 'm']);
		expect(kids).toHaveLength(2);
		expect(kids[0].id).not.toBe(kids[1].id);
		expect(plaintextOf(kids[0])).toBe('in');
	});

	it('IME freeze inside a callout child: no re-project, then one insert-text on the child', () => {
		const el = host();
		const doc = page([callout('c', [para('n', 'hi')]), para('z', 'Z')]);
		project(el, doc);
		let state = {
			...createEditorState(doc),
			selection: { anchor: { blockId: 'n', offset: 2 }, head: { blockId: 'n', offset: 2 } }
		};
		state = beginComposition(state);
		expect(shouldProject(state)).toBe(false);
		const spy = vi.spyOn(el, 'replaceChildren');
		syncView(el, state);
		expect(spy).not.toHaveBeenCalled();
		expect(el.querySelector('[data-block-id="n"]')?.getAttribute('data-parent-id')).toBe('c');
		const frozen = mapBeforeInput(
			state,
			{ inputType: 'insertCompositionText', data: 'あ', isComposing: true },
			state.selection
		);
		expect(frozen.preventDefault).toBe(false);
		expect(frozen.ops).toEqual([]);
		const snap = snapshotComposition(state, state.selection);
		const { ops } = commitComposition(state, snap, 'あ');
		expect(ops).toEqual([{ kind: 'insert-text', at: { blockId: 'n', offset: 2 }, text: 'あ' }]);
		state = dispatchMany({ ...state, composing: false }, ops);
		expect(plaintextOf(findBlock(state.page, 'n')!)).toBe('hiあ');
		spy.mockRestore();
		el.remove();
	});

	it('drag-select from a callout child to the following paragraph maps distinct block ids', () => {
		const el = host();
		const doc = page([callout('c', [para('n', 'inside')]), para('z', 'after')]);
		project(el, doc);
		const child = el.querySelector('[data-block-id="n"]') as HTMLElement;
		const after = el.querySelector('[data-block-id="z"]') as HTMLElement;
		const tN = [...child.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		const tZ = [...after.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		const range = rangeFromEndpoints(el, tN, 2, tZ, 3);
		expect(range?.anchor.blockId).toBe('n');
		expect(range?.head.blockId).toBe('z');
		expect(range?.anchor.blockId !== range?.head.blockId).toBe(true);
		const chrome = el.querySelector('[data-block-id="c"]') as HTMLElement;
		expect(chrome.contains(child)).toBe(false);
		el.remove();
	});

	it('JSON paste inside a callout child stamps parentId', () => {
		const src = createEditorState(page([para('a', 'Hi')]));
		const json = serializeSlice(src.page.blocks);
		const dest = createEditorState(page([callout('c', [para('n', 'ab')])]));
		const live = { anchor: { blockId: 'n', offset: 2 }, head: { blockId: 'n', offset: 2 } };
		const ops = pasteOps(dest, live, { json });
		const inserted = ops.find((op) => op.kind === 'insert-block');
		expect(inserted?.kind).toBe('insert-block');
		if (inserted?.kind === 'insert-block') {
			expect(inserted.parentId).toBe('c');
			expect(inserted.block.id).not.toBe('a');
		}
	});

	it('KbEditor: one host, overlay stays in the gutter, drag-select child → following paragraph', async () => {
		let state = createEditorState(page([callout('c', [para('n', 'inside')]), para('z', 'after')]));
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
		const overlay = container.querySelector('[data-testid="kb-gutter-overlay"]') as HTMLElement;
		expect(kbHost.getAttribute('contenteditable')).toBe('true');
		expect(kbHost.querySelectorAll('[contenteditable="true"]').length).toBe(0);
		expect(kbHost.querySelector('ul')).toBeNull();
		expect(kbHost.querySelector('ol')).toBeNull();
		expect(kbHost.querySelector('table')).toBeNull();
		expect(overlay).toBeTruthy();
		expect(gutter.contains(overlay)).toBe(true);
		expect(kbHost.contains(overlay)).toBe(false);
		expect(overlay.style.pointerEvents).toBe('none');
		expect(overlay.getAttribute('data-parent-id')).toBe('c');

		const child = kbHost.querySelector('[data-block-id="n"]') as HTMLElement;
		const after = kbHost.querySelector('[data-block-id="z"]') as HTMLElement;
		const tN = [...child.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		const tZ = [...after.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		const mapped = rangeFromEndpoints(kbHost, tN, 1, tZ, 2);
		expect(mapped?.anchor.blockId).toBe('n');
		expect(mapped?.head.blockId).toBe('z');

		const handle = gutter.querySelector('[data-block-id="n"]') as HTMLElement;
		expect(handle.getAttribute('data-parent-id')).toBe('c');
		expect(kbHost.contains(handle)).toBe(false);
		unmount();
	});

	it('clicking toggle chrome dispatches set-toggle', () => {
		const src = page([toggle('t', [para('n', 'hid')], true)]);
		const next = dispatch(createEditorState(src), { kind: 'set-toggle', id: 't', open: false });
		expect(next.page.blocks[0]).toMatchObject({ type: 'toggle', open: false });
		expect(visibleOrder(next.page).map((b) => b.id)).toEqual(['t']);
	});
});
