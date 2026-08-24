import {
	canonicalMarks,
	isContainer,
	isTextLike,
	parentIdOf,
	parentOf,
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
export const PARENT_ID_ATTR = 'data-parent-id';
export const DEPTH_ATTR = 'data-depth';

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

function setTreeAttrs(el: HTMLElement, block: Block, parentId: string | null, depth: number): void {
	el.setAttribute(BLOCK_ID_ATTR, block.id);
	el.setAttribute(BLOCK_TYPE_ATTR, block.type);
	el.setAttribute(DEPTH_ATTR, String(depth));
	if (parentId) el.setAttribute(PARENT_ID_ATTR, parentId);
}

function renderTextLike(
	doc: Document,
	block: Extract<Block, { content: Inline[] }>,
	parentId: string | null,
	depth: number
): HTMLElement {
	let el: HTMLElement;
	if (block.type === 'heading') {
		el = doc.createElement(`h${block.level}`);
	} else if (block.type === 'list_item') {
		el = doc.createElement('div');
		el.setAttribute('data-ordered', block.ordered ? 'true' : 'false');
	} else {
		el = doc.createElement('p');
	}
	setTreeAttrs(el, block, parentId, depth);
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

function renderCode(
	doc: Document,
	block: Extract<Block, { type: 'code' }>,
	parentId: string | null,
	depth: number
): HTMLElement {
	const pre = doc.createElement('pre');
	setTreeAttrs(pre, block, parentId, depth);
	if (block.language) pre.setAttribute('data-language', block.language);
	const code = doc.createElement('code');
	code.appendChild(doc.createTextNode(block.text));
	pre.appendChild(code);
	stripMagicBr(pre);
	return pre;
}

function renderDivider(
	doc: Document,
	block: Extract<Block, { type: 'divider' }>,
	parentId: string | null,
	depth: number
): HTMLElement {
	const hr = doc.createElement('hr');
	setTreeAttrs(hr, block, parentId, depth);
	return hr;
}

function renderImage(
	doc: Document,
	block: Extract<Block, { type: 'image' }>,
	parentId: string | null,
	depth: number
): HTMLElement {
	const wrap = doc.createElement('div');
	setTreeAttrs(wrap, block, parentId, depth);
	const img = doc.createElement('img');
	const src = allowlistedSrc(block.src);
	if (src) img.setAttribute('src', src);
	img.setAttribute('alt', block.alt);
	wrap.appendChild(img);
	return wrap;
}

/** Chrome only: host-direct sibling of children, never a nested CE wrapper. */
function renderContainer(
	doc: Document,
	block: Extract<Block, { type: 'callout' | 'toggle' }>,
	parentId: string | null,
	depth: number
): HTMLElement {
	const el = doc.createElement('div');
	setTreeAttrs(el, block, parentId, depth);
	if (block.type === 'callout') el.setAttribute('data-variant', block.variant);
	else el.setAttribute('data-open', block.open ? 'true' : 'false');
	return el;
}

function locAttrs(page: KbPage, id: string): { parentId: string | null; depth: number } {
	const loc = parentOf(page, id);
	const parentId = loc ? parentIdOf(loc.parent) : null;
	return { parentId, depth: parentId ? 1 : 0 };
}

export function renderBlock(
	doc: Document,
	block: Block,
	parentId: string | null = null,
	depth = 0
): HTMLElement {
	if (isTextLike(block)) return renderTextLike(doc, block, parentId, depth);
	if (block.type === 'code') return renderCode(doc, block, parentId, depth);
	if (block.type === 'divider') return renderDivider(doc, block, parentId, depth);
	if (block.type === 'image') return renderImage(doc, block, parentId, depth);
	if (isContainer(block)) return renderContainer(doc, block, parentId, depth);
	const el = doc.createElement('div');
	setTreeAttrs(el, block, parentId, depth);
	return el;
}

/** Imperative projection into the one contenteditable host. Never innerHTML. */
export function project(host: HTMLElement, page: KbPage): void {
	const doc = host.ownerDocument;
	const nodes: HTMLElement[] = [];
	for (const block of visibleOrder(page)) {
		const { parentId, depth } = locAttrs(page, block.id);
		nodes.push(renderBlock(doc, block, parentId, depth));
	}
	host.replaceChildren(...nodes);
	for (const child of host.children) stripMagicBr(child as HTMLElement);
}

/** Re-project unless composing (IME freeze). */
export function syncView(host: HTMLElement, state: EditorState): void {
	if (state.composing) return;
	project(host, state.page);
}
