import { describe, expect, it, vi } from 'vitest';
import { copyPayload, stripHtml } from './clipboard.js';
import { confirmedCompositionText } from './composition.js';
import {
	COLLAB_SEL_ATTR,
	COLLAB_WIDGET_ATTR,
	paintCarets,
	type RemoteCaret
} from './decorations.js';
import { project, syncView } from './project.js';
import { plaintextFromDom, pointFromDom, rangeFromSelection, textNodes } from './selection.js';
import { createEditorState } from './state.js';
import { page, para } from './testFixtures.js';

function hasUnpairedSurrogate(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			if (i + 1 >= text.length) return true;
			const low = text.charCodeAt(i + 1);
			if (low < 0xdc00 || low > 0xdfff) return true;
			i++;
		} else if (c >= 0xdc00 && c <= 0xdfff) {
			return true;
		}
	}
	return false;
}

function host(): HTMLDivElement {
	const el = document.createElement('div');
	el.contentEditable = 'true';
	document.body.append(el);
	return el;
}

function alice(over: Partial<RemoteCaret> = {}): RemoteCaret {
	return {
		clientId: 'alice',
		user: { name: 'Alice', color: '#e11' },
		anchor: { blockId: 'p', offset: 2 },
		head: { blockId: 'p', offset: 2 },
		...over
	};
}

describe('remote caret widgets', () => {
	it('inserts contenteditable=false widgets after project without mutating the page', () => {
		const el = host();
		const doc = page([para('p', 'hello')]);
		project(el, doc, { carets: [alice()] });
		const widget = el.querySelector(`[${COLLAB_WIDGET_ATTR}]`) as HTMLElement | null;
		expect(widget).toBeTruthy();
		expect(widget!.getAttribute('contenteditable')).toBe('false');
		expect(widget!.getAttribute('data-client-id')).toBe('alice');
		const block = el.querySelector('[data-block-id="p"]') as HTMLElement;
		expect(block.contains(widget!)).toBe(true);
		expect(widget!.parentElement === el).toBe(false);
		expect(doc.blocks[0]).toMatchObject({ type: 'paragraph', content: [{ text: 'hello' }] });
		el.remove();
	});

	it('rebuilds widgets after project', () => {
		const el = host();
		const doc = page([para('p', 'hello')]);
		project(el, doc, { carets: [alice()] });
		expect(el.querySelectorAll(`[${COLLAB_WIDGET_ATTR}]`)).toHaveLength(1);
		project(el, doc, { carets: [alice({ head: { blockId: 'p', offset: 5 } })] });
		expect(el.querySelectorAll(`[${COLLAB_WIDGET_ATTR}]`)).toHaveLength(1);
		const block = el.querySelector('[data-block-id="p"]') as HTMLElement;
		expect(plaintextFromDom(block)).toBe('hello');
		paintCarets(el, doc, []);
		expect(el.querySelector(`[${COLLAB_WIDGET_ATTR}]`)).toBeNull();
		el.remove();
	});

	it('does not paint widgets while composing', () => {
		const el = host();
		const doc = page([para('p', 'hello')]);
		const state = { ...createEditorState(doc), composing: true };
		syncView(el, state, { carets: [alice()] });
		expect(el.querySelector(`[${COLLAB_WIDGET_ATTR}]`)).toBeNull();
		project(el, doc, { carets: [alice()], composing: true });
		expect(el.querySelector(`[${COLLAB_WIDGET_ATTR}]`)).toBeNull();
		expect(el.querySelector('[data-block-id="p"]')).toBeTruthy();
		el.remove();
	});

	it('strips already-painted widgets on syncView while composing without replaceChildren', () => {
		const el = host();
		const doc = page([para('p', 'hello')]);
		project(el, doc, { carets: [alice()] });
		const block = el.querySelector('[data-block-id="p"]') as HTMLElement;
		expect(el.querySelector(`[${COLLAB_WIDGET_ATTR}]`)).toBeTruthy();
		expect(block.textContent).toContain('Alice');
		const spy = vi.spyOn(el, 'replaceChildren');
		syncView(el, { ...createEditorState(doc), composing: true }, { carets: [alice()] });
		expect(spy).not.toHaveBeenCalled();
		expect(el.querySelector(`[${COLLAB_WIDGET_ATTR}]`)).toBeNull();
		expect(plaintextFromDom(block)).toBe('hello');
		expect(block.textContent).toBe('hello');
		expect(
			confirmedCompositionText({ data: null }, plaintextFromDom(block), 'hello')
		).toBe('');
		spy.mockRestore();
		el.remove();
	});

	it('maps a parent offset at the widget to the caret point, not end-of-block', () => {
		const el = host();
		const doc = page([para('p', 'hello')]);
		project(el, doc, { carets: [alice()] });
		const block = el.querySelector('[data-block-id="p"]') as HTMLElement;
		const widget = block.querySelector(`[${COLLAB_WIDGET_ATTR}]`) as HTMLElement;
		const index = [...block.childNodes].indexOf(widget);
		expect(index).toBeGreaterThan(0);
		expect(pointFromDom(el, block, index)).toEqual({ blockId: 'p', offset: 2 });
		expect(pointFromDom(el, widget, 0)).toEqual({ blockId: 'p', offset: 2 });
		expect(pointFromDom(el, widget, 1)).toEqual({ blockId: 'p', offset: 2 });
		const sel = document.getSelection()!;
		sel.removeAllRanges();
		const range = document.createRange();
		range.setStart(block, index);
		range.collapse(true);
		sel.addRange(range);
		expect(rangeFromSelection(el, sel)).toEqual({
			anchor: { blockId: 'p', offset: 2 },
			head: { blockId: 'p', offset: 2 }
		});
		el.remove();
	});

	it('does not split a surrogate pair when painting a caret at a low-surrogate offset', () => {
		const el = host();
		const doc = page([para('p', 'a👍b')]);
		project(el, doc, {
			carets: [
				alice({
					anchor: { blockId: 'p', offset: 2 },
					head: { blockId: 'p', offset: 2 }
				})
			]
		});
		const block = el.querySelector('[data-block-id="p"]') as HTMLElement;
		const parts = textNodes(block).map((t) => t.data);
		expect(parts.join('')).toBe('a👍b');
		for (const part of parts) expect(hasUnpairedSurrogate(part)).toBe(false);
		el.remove();
	});

	it('skips widgets in textNodes and clipboard plaintext', () => {
		const el = host();
		const doc = page([para('p', 'hello')]);
		project(el, doc, { carets: [alice()] });
		const block = el.querySelector('[data-block-id="p"]') as HTMLElement;
		expect(textNodes(block).every((t) => !t.parentElement?.closest(`[${COLLAB_WIDGET_ATTR}]`))).toBe(
			true
		);
		expect(textNodes(block).map((t) => t.data).join('')).toBe('hello');
		expect(plaintextFromDom(block)).toBe('hello');
		expect(plaintextFromDom(block)).not.toContain('Alice');

		const live = { anchor: { blockId: 'p', offset: 0 }, head: { blockId: 'p', offset: 5 } };
		const payload = copyPayload({ ...createEditorState(doc), selection: live }, live);
		expect(payload).toBeTruthy();
		expect(payload!.plain).toBe('hello');
		expect(payload!.plain).not.toContain('Alice');
		expect(payload!.json).not.toContain('Alice');
		expect(payload!.json).not.toContain(COLLAB_WIDGET_ATTR);
		expect(stripHtml(el.innerHTML).replace(/\n/g, '')).toBe('hello');
		expect(stripHtml(el.innerHTML)).not.toContain('Alice');

		const fromText = pointFromDom(el, textNodes(block)[0], 2);
		expect(fromText).toEqual({ blockId: 'p', offset: 2 });
		el.remove();
	});

	it('wraps a non-collapsed remote range inside the block, not as a floating overlay', () => {
		const el = host();
		const doc = page([para('p', 'hello')]);
		project(el, doc, {
			carets: [alice({ anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 4 } })]
		});
		const block = el.querySelector('[data-block-id="p"]') as HTMLElement;
		const sel = block.querySelector(`[${COLLAB_SEL_ATTR}]`) as HTMLElement | null;
		expect(sel).toBeTruthy();
		expect(block.contains(sel!)).toBe(true);
		expect(sel!.parentElement === el).toBe(false);
		expect(plaintextFromDom(block)).toBe('hello');
		el.remove();
	});
});
