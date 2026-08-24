import { findBlock, plaintextOf, type KbPage, type Point } from '@shared-packages/kb-model';
import { orderedRange } from './range.js';

export const COLLAB_WIDGET_ATTR = 'data-collab-widget';
export const COLLAB_SEL_ATTR = 'data-collab-sel';

export type RemoteCaret = {
	clientId: string;
	user: { name: string; color: string };
	anchor: Point;
	head: Point;
};

function cssEscape(value: string): string {
	if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
	return value.replace(/"/g, '\\"');
}

function blockEl(host: HTMLElement, blockId: string): HTMLElement | null {
	return host.querySelector(`[data-block-id="${cssEscape(blockId)}"]`);
}

function inWidget(node: Node): boolean {
	const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	return !!el?.closest(`[${COLLAB_WIDGET_ATTR}]`);
}

/** Document text nodes only; collab widgets are skipped. */
function textNodes(block: HTMLElement): Text[] {
	const out: Text[] = [];
	const walk = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
	let node: Node | null;
	while ((node = walk.nextNode())) {
		if (inWidget(node)) continue;
		out.push(node as Text);
	}
	return out;
}

function nodeAtOffset(block: HTMLElement, offset: number): { node: Text; offset: number } | null {
	const texts = textNodes(block);
	if (texts.length === 0) return null;
	let remaining = Math.max(0, offset);
	for (let i = 0; i < texts.length; i++) {
		const text = texts[i];
		const len = text.data.length;
		if (remaining < len || (remaining === len && i === texts.length - 1)) {
			return { node: text, offset: Math.min(remaining, len) };
		}
		remaining -= len;
	}
	const last = texts[texts.length - 1];
	return { node: last, offset: last.data.length };
}

function unwrap(el: Element): void {
	const parent = el.parentNode;
	if (!parent) {
		el.remove();
		return;
	}
	while (el.firstChild) parent.insertBefore(el.firstChild, el);
	parent.removeChild(el);
}

function clearDecorations(host: HTMLElement): void {
	for (const el of [...host.querySelectorAll(`[${COLLAB_WIDGET_ATTR}]`)]) el.remove();
	for (const el of [...host.querySelectorAll(`[${COLLAB_SEL_ATTR}]`)]) unwrap(el);
}

function createCaretWidget(doc: Document, caret: RemoteCaret): HTMLElement {
	const wrap = doc.createElement('span');
	wrap.setAttribute(COLLAB_WIDGET_ATTR, '1');
	wrap.setAttribute('contenteditable', 'false');
	wrap.setAttribute('data-client-id', caret.clientId);
	wrap.style.borderLeft = `2px solid ${caret.user.color}`;
	wrap.style.marginLeft = '-1px';
	wrap.style.display = 'inline-block';
	wrap.style.width = '0';
	wrap.style.height = '1em';
	wrap.style.position = 'relative';
	wrap.style.pointerEvents = 'none';
	wrap.style.userSelect = 'none';
	wrap.style.verticalAlign = 'text-bottom';

	const label = doc.createElement('span');
	label.textContent = caret.user.name;
	label.style.position = 'absolute';
	label.style.top = '-1.05em';
	label.style.left = '0';
	label.style.background = caret.user.color;
	label.style.color = '#fff';
	label.style.fontSize = '0.7em';
	label.style.lineHeight = '1';
	label.style.padding = '0 0.2em';
	label.style.whiteSpace = 'nowrap';
	label.style.pointerEvents = 'none';
	label.style.userSelect = 'none';
	wrap.appendChild(label);
	return wrap;
}

function insertWidget(block: HTMLElement, offset: number, widget: Node): void {
	const at = nodeAtOffset(block, offset);
	if (!at) {
		block.appendChild(widget);
		return;
	}
	const range = block.ownerDocument.createRange();
	range.setStart(at.node, at.offset);
	range.collapse(true);
	range.insertNode(widget);
}

function wrapSlice(block: HTMLElement, from: number, to: number, color: string): void {
	if (to <= from) return;
	const start = nodeAtOffset(block, from);
	const end = nodeAtOffset(block, to);
	if (!start || !end) return;
	const doc = block.ownerDocument;
	const range = doc.createRange();
	try {
		range.setStart(start.node, start.offset);
		range.setEnd(end.node, end.offset);
	} catch {
		return;
	}
	if (range.collapsed) return;
	const span = doc.createElement('span');
	span.setAttribute(COLLAB_SEL_ATTR, '1');
	span.style.backgroundColor = `color-mix(in srgb, ${color} 28%, transparent)`;
	try {
		range.surroundContents(span);
	} catch {
		try {
			const contents = range.extractContents();
			span.appendChild(contents);
			range.insertNode(span);
		} catch {
			// caret still paints if the highlight cannot wrap
		}
	}
}

function paintSelection(host: HTMLElement, page: KbPage, caret: RemoteCaret): void {
	if (caret.anchor.blockId === caret.head.blockId && caret.anchor.offset === caret.head.offset) {
		return;
	}
	const { start, end } = orderedRange(page, { anchor: caret.anchor, head: caret.head });
	const blocks = [...host.children].filter((el): el is HTMLElement => el instanceof HTMLElement);
	let started = false;
	for (const el of blocks) {
		const id = el.getAttribute('data-block-id');
		if (!id) continue;
		if (id === start.blockId) started = true;
		if (!started) continue;
		const block = findBlock(page, id);
		const len = block ? plaintextOf(block).length : 0;
		const from = id === start.blockId ? start.offset : 0;
		const to = id === end.blockId ? end.offset : len;
		wrapSlice(el, from, to, caret.user.color);
		if (id === end.blockId) break;
	}
}

function paintHead(host: HTMLElement, page: KbPage, caret: RemoteCaret): void {
	const block = findBlock(page, caret.head.blockId);
	if (!block) return;
	const el = blockEl(host, caret.head.blockId);
	if (!el) return;
	const len = plaintextOf(block).length;
	const offset = Math.max(0, Math.min(caret.head.offset, len));
	insertWidget(el, offset, createCaretWidget(el.ownerDocument, caret));
}

/**
 * Insert contenteditable=false caret/selection widgets without mutating KbPage.
 * Caller must not invoke this while composing (IME freeze).
 */
export function paintCarets(host: HTMLElement, page: KbPage, carets: RemoteCaret[]): void {
	clearDecorations(host);
	for (const caret of carets) paintSelection(host, page, caret);
	for (const caret of carets) paintHead(host, page, caret);
}

/** Drop widget markup from HTML so clipboard plaintext cannot leak remote names. */
export function stripCollabWidgetsHtml(html: string): string {
	return html.replace(/<[^>]*\bdata-collab-widget\b[^>]*>[\s\S]*?<\/[^>]+>/gi, '');
}
