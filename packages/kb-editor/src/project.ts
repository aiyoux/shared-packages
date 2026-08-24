import {
	canonicalMarks,
	isTextLike,
	visibleOrder,
	type Block,
	type Inline,
	type KbPage,
	type Mark
} from '@shared-packages/kb-model';
import { allowlistedHref, allowlistedSrc } from './href.js';
import type { EditorState } from './state.js';

export const BLOCK_ID_ATTR = 'data-block-id';
export const BLOCK_TYPE_ATTR = 'data-block-type';

function markElement(doc: Document, mark: Mark): HTMLElement {
	switch (mark.type) {
		case 'bold':
			return doc.createElement('strong');
		case 'italic':
			return doc.createElement('em');
		case 'code':
			return doc.createElement('code');
		case 'link': {
			const a = doc.createElement('a');
			const href = allowlistedHref(mark.href);
			if (href) a.setAttribute('href', href);
			return a;
		}
	}
}

function wrapMarks(doc: Document, text: Text, marks: Mark[]): Node {
	let node: Node = text;
	const ordered = canonicalMarks(marks);
	for (let i = ordered.length - 1; i >= 0; i--) {
		const el = markElement(doc, ordered[i]);
		el.appendChild(node);
		node = el;
	}
	return node;
}

function appendSpans(doc: Document, parent: HTMLElement, content: Inline[]): void {
	if (content.length === 0) {
		parent.appendChild(doc.createTextNode(''));
		return;
	}
	for (const span of content) {
		const text = doc.createTextNode(span.text);
		parent.appendChild(wrapMarks(doc, text, span.marks ?? []));
	}
	if (!parent.firstChild) parent.appendChild(doc.createTextNode(''));
}

function stripMagicBr(el: HTMLElement): void {
	const walk = el.querySelectorAll('br');
	for (const br of walk) br.remove();
}

function renderTextLike(doc: Document, block: Extract<Block, { content: Inline[] }>): HTMLElement {
	let el: HTMLElement;
	if (block.type === 'heading') {
		el = doc.createElement(`h${block.level}`);
	} else if (block.type === 'list_item') {
		el = doc.createElement('div');
		el.setAttribute('data-ordered', block.ordered ? 'true' : 'false');
	} else {
		el = doc.createElement('p');
	}
	el.setAttribute(BLOCK_ID_ATTR, block.id);
	el.setAttribute(BLOCK_TYPE_ATTR, block.type);
	appendSpans(doc, el, block.content);
	stripMagicBr(el);
	if (!hasTextNode(el)) el.appendChild(doc.createTextNode(''));
	return el;
}

function hasTextNode(el: HTMLElement): boolean {
	const walk = docWalker(el);
	let node: Node | null;
	while ((node = walk.nextNode())) {
		if (node.nodeType === Node.TEXT_NODE) return true;
	}
	return false;
}

function docWalker(el: HTMLElement): TreeWalker {
	return el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
}

function renderCode(doc: Document, block: Extract<Block, { type: 'code' }>): HTMLElement {
	const pre = doc.createElement('pre');
	pre.setAttribute(BLOCK_ID_ATTR, block.id);
	pre.setAttribute(BLOCK_TYPE_ATTR, 'code');
	if (block.language) pre.setAttribute('data-language', block.language);
	const code = doc.createElement('code');
	code.appendChild(doc.createTextNode(block.text));
	pre.appendChild(code);
	stripMagicBr(pre);
	return pre;
}

function renderDivider(doc: Document, block: Extract<Block, { type: 'divider' }>): HTMLElement {
	const hr = doc.createElement('hr');
	hr.setAttribute(BLOCK_ID_ATTR, block.id);
	hr.setAttribute(BLOCK_TYPE_ATTR, 'divider');
	return hr;
}

function renderImage(doc: Document, block: Extract<Block, { type: 'image' }>): HTMLElement {
	const wrap = doc.createElement('div');
	wrap.setAttribute(BLOCK_ID_ATTR, block.id);
	wrap.setAttribute(BLOCK_TYPE_ATTR, 'image');
	const img = doc.createElement('img');
	const src = allowlistedSrc(block.src);
	if (src) img.setAttribute('src', src);
	img.setAttribute('alt', block.alt);
	wrap.appendChild(img);
	return wrap;
}

export function renderBlock(doc: Document, block: Block): HTMLElement {
	if (isTextLike(block)) return renderTextLike(doc, block);
	if (block.type === 'code') return renderCode(doc, block);
	if (block.type === 'divider') return renderDivider(doc, block);
	return renderImage(doc, block);
}

/** Imperative projection into the one contenteditable host. Never innerHTML. */
export function project(host: HTMLElement, page: KbPage): void {
	const doc = host.ownerDocument;
	const nodes: HTMLElement[] = [];
	for (const block of visibleOrder(page)) nodes.push(renderBlock(doc, block));
	host.replaceChildren(...nodes);
	for (const child of host.children) stripMagicBr(child as HTMLElement);
}

/** Re-project unless composing (IME freeze). */
export function syncView(host: HTMLElement, state: EditorState): void {
	if (state.composing) return;
	project(host, state.page);
}
