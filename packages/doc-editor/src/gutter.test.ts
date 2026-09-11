import { describe, expect, it } from 'vitest';
import {
	blockFromPoint,
	dropAfterId,
	dropLineY,
	dropTarget,
	dropWhere,
	gutterClickRange,
	gutterOrder,
	handleBoxes,
	handleHeights,
	overlayBoxes
} from './gutter.js';
import { project } from './project.js';
import { createEditorState, dispatch } from './state.js';
import { callout, divider, page, para } from './testFixtures.js';

describe('gutter drag with unknown blocks', () => {
	const widget = {
		id: 'u1',
		type: 'custom_widget',
		children: [para('u1c', 'inner')]
	} as unknown as Parameters<typeof page>[0][number];

	it('gives an unknown block a handle and lets it be moved', () => {
		const doc = page([para('a', '1'), widget, para('z', '2')]);
		expect(gutterOrder(doc).map((b) => b.id)).toEqual(['a', 'u1', 'z']);
		expect(dropTarget(doc, 'u1', 'z', 'after')).toEqual({ afterId: 'z', parentId: null });
		// Its children are opaque: never a drop target.
		expect(dropTarget(doc, 'a', 'u1c', 'after')).toBe('noop');
	});
});

describe('gutter drag', () => {
	it('computes move-block afterId from drop half', () => {
		const doc = page([para('a', '1'), para('b', '2'), para('c', '3')]);
		expect(dropAfterId(doc, 'c', 'a', 'before')).toBe(null);
		expect(dropAfterId(doc, 'c', 'a', 'after')).toBe('a');
		expect(dropAfterId(doc, 'a', 'c', 'after')).toBe('c');
		expect(dropAfterId(doc, 'b', 'b', 'before')).toBe('noop');
		expect(dropAfterId(doc, 'a', 'b', 'before')).toBe('noop');
		expect(dropAfterId(doc, 'missing', 'a', 'after')).toBe('noop');
		expect(dropAfterId(doc, 'a', 'missing', 'after')).toBe('noop');
		expect(dropWhere(10, { top: 0, height: 40 })).toBe('before');
		expect(dropWhere(30, { top: 0, height: 40 })).toBe('after');
	});

	it('dispatch move-block reorders', () => {
		const state = createEditorState(page([para('a', '1'), para('b', '2'), para('c', '3')]));
		const next = dispatch(state, { kind: 'move-block', id: 'c', afterId: null });
		expect(next.page.blocks.map((b) => b.id)).toEqual(['c', 'a', 'b']);
	});

	it('handles live outside the contenteditable host', () => {
		const host = document.createElement('div');
		host.contentEditable = 'true';
		const gutter = document.createElement('div');
		gutter.contentEditable = 'false';
		const wrap = document.createElement('div');
		wrap.append(gutter, host);
		document.body.append(wrap);
		project(host, page([para('a', '1'), para('b', '2')]));
		const handle = document.createElement('button');
		handle.type = 'button';
		handle.setAttribute('aria-label', 'Drag to reorder');
		gutter.append(handle);
		expect(host.contains(handle)).toBe(false);
		expect(host.querySelector('ul')).toBeNull();
		expect(host.querySelector('ol')).toBeNull();
		wrap.remove();
	});

	it('drop onto a nested child stamps parentId; overlay paint stays out of the host', () => {
		const doc = page([callout('c', [para('n', 'in')]), para('z', 'Z')]);
		expect(dropTarget(doc, 'z', 'n', 'after')).toEqual({ afterId: 'n', parentId: 'c' });
		expect(dropAfterId(doc, 'z', 'n', 'after')).toBe('n');
		const host = document.createElement('div');
		document.body.append(host);
		project(host, doc);
		const boxes = overlayBoxes(host);
		expect(boxes).toHaveLength(1);
		expect(boxes[0].parentId).toBe('c');
		host.remove();
	});

	it('handleBoxes ignores a display:none gutter and measures from the host', () => {
		function rect(top: number, height: number): DOMRect {
			return {
				x: 0,
				y: top,
				top,
				left: 0,
				bottom: top + height,
				right: 40,
				width: 40,
				height,
				toJSON() {
					return this;
				}
			};
		}
		const doc = page([para('a', '1'), para('b', '2')]);
		const host = document.createElement('div');
		const gutter = document.createElement('div');
		gutter.style.display = 'none';
		document.body.append(gutter, host);
		project(host, doc);
		const a = host.querySelector('[data-block-id="a"]') as HTMLElement;
		const b = host.querySelector('[data-block-id="b"]') as HTMLElement;
		host.getBoundingClientRect = () => rect(50, 200);
		gutter.getBoundingClientRect = () => rect(0, 0);
		a.getBoundingClientRect = () => rect(100, 20);
		b.getBoundingClientRect = () => rect(128, 20);
		const boxes = handleBoxes(host, doc, gutter);
		expect(boxes.map((box) => box.id)).toEqual(['a', 'b']);
		// Origin is the host (50), not the hidden gutter's 0×0 rect.
		expect(boxes[0].top).toBe(50);
		expect(boxes[1].top).toBe(78);
		host.remove();
		gutter.remove();
	});

	it('handle boxes align to each block border box; margin gaps belong to no handle', () => {
		// Handles are absolutely positioned from `handleBoxes`, so a handle
		// spans exactly its block's own box and the ⋮⋮ dots centre on it. The
		// old flex-column sizing (top-to-next-top, absorbing margin-bottom)
		// made the dots hug the top of multi-line blocks; margins now belong
		// to no handle at all.
		function rect(top: number, height: number): DOMRect {
			return {
				x: 0,
				y: top,
				top,
				left: 0,
				bottom: top + height,
				right: 40,
				width: 40,
				height,
				toJSON() {
					return this;
				}
			};
		}
		const doc = page([para('a', '1'), para('b', '2'), para('c', '3')]);
		const host = document.createElement('div');
		const gutter = document.createElement('div');
		document.body.append(gutter, host);
		project(host, doc);
		const a = host.querySelector('[data-block-id="a"]') as HTMLElement;
		const b = host.querySelector('[data-block-id="b"]') as HTMLElement;
		const c = host.querySelector('[data-block-id="c"]') as HTMLElement;
		// 20px content boxes with an 8px margin gap between them.
		a.getBoundingClientRect = () => rect(100, 20);
		b.getBoundingClientRect = () => rect(128, 20);
		c.getBoundingClientRect = () => rect(156, 20);
		gutter.getBoundingClientRect = () => rect(90, 200);
		const boxes = handleBoxes(host, doc, gutter);
		expect(boxes.map((b) => b.id)).toEqual(['a', 'b', 'c']);
		// Tops are gutter-relative: block top minus the gutter's origin.
		expect(boxes[0].top).toBe(10);
		expect(boxes[1].top).toBe(38);
		expect(boxes[2].top).toBe(66);
		// Heights are the block's own box — the 8px gaps belong to no handle.
		expect(boxes[0].height).toBe(20);
		expect(boxes[1].height).toBe(20);
		expect(boxes[2].height).toBe(20);
		host.remove();
		gutter.remove();
	});

	it('blockFromPoint hit-tests the whole content column, skipping the dragged block', () => {
		function rect(top: number, height: number): DOMRect {
			return {
				x: 0,
				y: top,
				top,
				left: 0,
				bottom: top + height,
				right: 40,
				width: 40,
				height,
				toJSON() {
					return this;
				}
			};
		}
		const doc = page([para('a', '1'), para('b', '2'), para('c', '3')]);
		const host = document.createElement('div');
		document.body.append(host);
		project(host, doc);
		const a = host.querySelector('[data-block-id="a"]') as HTMLElement;
		const b = host.querySelector('[data-block-id="b"]') as HTMLElement;
		const c = host.querySelector('[data-block-id="c"]') as HTMLElement;
		a.getBoundingClientRect = () => rect(0, 20);
		b.getBoundingClientRect = () => rect(28, 20);
		c.getBoundingClientRect = () => rect(56, 20);

		// Top half before, bottom half after.
		expect(blockFromPoint(host, doc, 5)?.id).toBe('a');
		expect(blockFromPoint(host, doc, 5)?.where).toBe('before');
		expect(blockFromPoint(host, doc, 18)?.where).toBe('after');
		// Cursor in the margin gap still hits the nearest block.
		expect(blockFromPoint(host, doc, 24)?.id).toBe('a');
		// The dragged block is skipped: a drag of `b` hovering its own old
		// position lands on the nearest other block instead.
		expect(blockFromPoint(host, doc, 30, 'b')?.id).toBe('a');
		expect(blockFromPoint(host, doc, 30, 'b')?.where).toBe('after');
		host.remove();
	});

	it('dropLineY paints one line per gap: after X lands on the next sibling top', () => {
		function rect(top: number, height: number): DOMRect {
			return {
				x: 0,
				y: top,
				top,
				left: 0,
				bottom: top + height,
				right: 40,
				width: 40,
				height,
				toJSON() {
					return this;
				}
			};
		}
		const doc = page([para('a', '1'), para('b', '2'), para('c', '3')]);
		const host = document.createElement('div');
		document.body.append(host);
		project(host, doc);
		const a = host.querySelector('[data-block-id="a"]') as HTMLElement;
		const b = host.querySelector('[data-block-id="b"]') as HTMLElement;
		const c = host.querySelector('[data-block-id="c"]') as HTMLElement;
		// 20px boxes with an 8px margin gap between them.
		a.getBoundingClientRect = () => rect(0, 20);
		b.getBoundingClientRect = () => rect(28, 20);
		c.getBoundingClientRect = () => rect(56, 20);

		// The shared boundary a|b: reading it as "after a" or "before b" must
		// produce the identical line — the gap's midpoint (20, 28 → 24).
		expect(dropLineY(host, doc, { id: 'a', where: 'after', rect: rect(0, 20) }, 'noop')).toBe(24);
		expect(dropLineY(host, doc, { id: 'b', where: 'before', rect: rect(28, 20) }, 'noop')).toBe(24);
		expect(dropLineY(host, doc, { id: 'b', where: 'after', rect: rect(28, 20) }, 'noop')).toBe(52);
		expect(dropLineY(host, doc, { id: 'c', where: 'before', rect: rect(56, 20) }, 'noop')).toBe(52);
		// A last block has no next sibling: the line closes at its own bottom.
		expect(dropLineY(host, doc, { id: 'c', where: 'after', rect: rect(56, 20) }, 'noop')).toBe(76);
		host.remove();
	});

	it('dropLineY for a container paints inside, under its last child', () => {
		function rect(top: number, height: number): DOMRect {
			return {
				x: 0,
				y: top,
				top,
				left: 0,
				bottom: top + height,
				right: 40,
				width: 40,
				height,
				toJSON() {
					return this;
				}
			};
		}
		const doc = page([callout('c', [para('n', 'in')]), para('z', 'Z')]);
		const host = document.createElement('div');
		document.body.append(host);
		project(host, doc);
		const calloutEl = host.querySelector('[data-block-id="c"]') as HTMLElement;
		const child = host.querySelector('[data-block-id="n"]') as HTMLElement;
		const z = host.querySelector('[data-block-id="z"]') as HTMLElement;
		calloutEl.getBoundingClientRect = () => rect(0, 24);
		child.getBoundingClientRect = () => rect(24, 18);
		z.getBoundingClientRect = () => rect(48, 20);

		// `after` the callout is an INTO drop ({ parentId: 'c' }): the line
		// sits under its last child — not at the callout bar's bottom and not
		// at the next outer block's top.
		const drop = dropTarget(doc, 'z', 'c', 'after');
		expect(drop).toEqual({ afterId: null, parentId: 'c' });
		expect(
			dropLineY(host, doc, { id: 'c', where: 'after', rect: rect(0, 24) }, drop)
		).toBe(42);
		// `before` the callout stays at the callout's top.
		expect(dropLineY(host, doc, { id: 'c', where: 'before', rect: rect(0, 24) }, 'noop')).toBe(0);
		host.remove();
	});
});

describe('gutterClickRange', () => {
	const doc = page([para('a', 'first'), para('b', 'second line'), divider('d')]);

	it('selects the whole clicked block and arms it', () => {
		expect(gutterClickRange(doc, null, 'b', false)).toEqual({
			range: { anchor: { blockId: 'b', offset: 0 }, head: { blockId: 'b', offset: 11 } },
			anchorId: 'b'
		});
	});

	it('clicking the armed block again collapses the selection and disarms', () => {
		expect(gutterClickRange(doc, 'b', 'b', false)).toEqual({
			range: { anchor: { blockId: 'b', offset: 0 }, head: { blockId: 'b', offset: 0 } },
			anchorId: null
		});
	});

	it('clicking a different block moves the whole-block selection', () => {
		expect(gutterClickRange(doc, 'a', 'b', false)).toEqual({
			range: { anchor: { blockId: 'b', offset: 0 }, head: { blockId: 'b', offset: 11 } },
			anchorId: 'b'
		});
	});

	it('shift-click extends a contiguous range from the armed block, keeping it armed', () => {
		expect(gutterClickRange(doc, 'a', 'b', true)).toEqual({
			range: { anchor: { blockId: 'a', offset: 0 }, head: { blockId: 'b', offset: 11 } },
			anchorId: 'a'
		});
	});

	it('shift-click with nothing armed just selects the clicked block', () => {
		expect(gutterClickRange(doc, null, 'b', true)).toEqual({
			range: { anchor: { blockId: 'b', offset: 0 }, head: { blockId: 'b', offset: 11 } },
			anchorId: 'b'
		});
	});

	it('treats an atomic block as a zero-length whole-block range', () => {
		expect(gutterClickRange(doc, null, 'd', false)).toEqual({
			range: { anchor: { blockId: 'd', offset: 0 }, head: { blockId: 'd', offset: 0 } },
			anchorId: 'd'
		});
	});

	it('returns null when the clicked block is gone', () => {
		expect(gutterClickRange(doc, null, 'nope', false)).toBeNull();
	});
});
