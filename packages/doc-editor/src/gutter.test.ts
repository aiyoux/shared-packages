import { describe, expect, it } from 'vitest';
import { dropAfterId, dropTarget, dropWhere, gutterOrder, handleHeights, overlayBoxes } from './gutter.js';
import { project } from './project.js';
import { createEditorState, dispatch } from './state.js';
import { callout, page, para } from './testFixtures.js';

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

	it('handle height spans to the next block top, not just its own offsetHeight', () => {
		// Regression: `.kb-gutter` is a flex column with no gap, but blocks in
		// `.kb-host` (paragraphs, headings, ...) carry a margin-bottom. Sizing
		// a handle to offsetHeight alone ignores that margin, so handles drift
		// out of alignment with their block — worse with every block added.
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
		// 20px content + an 8px margin-bottom gap before the next block's top.
		a.getBoundingClientRect = () => rect(0, 20);
		b.getBoundingClientRect = () => rect(28, 20);
		c.getBoundingClientRect = () => rect(56, 20);
		Object.defineProperty(c, 'offsetHeight', { configurable: true, value: 20 });
		const heights = handleHeights(host, doc);
		expect(heights.a).toBe(28);
		expect(heights.b).toBe(28);
		// Last block: nothing below it to measure to, keeps its own offsetHeight.
		expect(heights.c).toBe(20);
		host.remove();
	});
});
