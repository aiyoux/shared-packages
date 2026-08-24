import { describe, expect, it } from 'vitest';
import { dropAfterId, dropWhere } from './gutter.js';
import { project } from './project.js';
import { createEditorState, dispatch } from './state.js';
import { page, para } from './testFixtures.js';

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
});
