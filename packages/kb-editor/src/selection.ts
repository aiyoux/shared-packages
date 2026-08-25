import {
	documentOrder,
	findBlock,
	isHighSurrogate,
	isLowSurrogate,
	plaintextOf,
	type KbPage,
	type Point,
	type Range
} from '@shared-packages/kb-model';
import { BLOCK_ID_ATTR } from './project.js';
import { clampRange, collapsed } from './range.js';

const COLLAB_WIDGET_SELECTOR = '[data-collab-widget]';

function closestBlock(node: Node | null, host: HTMLElement): HTMLElement | null {
	if (!node) return null;
	const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	if (!el) return null;
	const block = el.closest(`[${BLOCK_ID_ATTR}]`);
	if (!block || !host.contains(block)) return null;
	return block as HTMLElement;
}

function inCollabWidget(node: Node): boolean {
	const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	return !!el?.closest(COLLAB_WIDGET_SELECTOR);
}

function widgetRoot(node: Node): Element | null {
	const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	return el?.closest(COLLAB_WIDGET_SELECTOR) ?? null;
}

function documentTextIn(node: Node): number {
	if (node.nodeType === Node.TEXT_NODE) {
		return inCollabWidget(node) ? 0 : (node as Text).data.length;
	}
	if (node.nodeType !== Node.ELEMENT_NODE) return 0;
	const el = node as Element;
	if (el.matches?.(COLLAB_WIDGET_SELECTOR) || el.closest(COLLAB_WIDGET_SELECTOR)) return 0;
	let n = 0;
	for (const child of el.childNodes) n += documentTextIn(child);
	return n;
}

/** Document plaintext before `target` (widgets contribute 0). */
function plaintextBeforeNode(block: HTMLElement, target: Node): number {
	if (target === block) return 0;
	let total = 0;
	let found = false;
	const visit = (node: Node): void => {
		if (found || node === target) {
			found = true;
			return;
		}
		if (node.nodeType === Node.TEXT_NODE) {
			if (!inCollabWidget(node)) total += (node as Text).data.length;
			return;
		}
		if (node.nodeType === Node.ELEMENT_NODE && (node as Element).hasAttribute('data-collab-widget')) {
			return;
		}
		for (const child of node.childNodes) {
			visit(child);
			if (found) return;
		}
	};
	for (const child of block.childNodes) {
		visit(child);
		if (found) break;
	}
	return total;
}

/** Document text only. Remote caret widgets are skipped so offsets match KbPage. */
export function textNodes(block: HTMLElement): Text[] {
	const out: Text[] = [];
	const walk = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
	let node: Node | null;
	while ((node = walk.nextNode())) {
		if (inCollabWidget(node)) continue;
		out.push(node as Text);
	}
	return out;
}

export function plaintextFromDom(block: HTMLElement): string {
	return textNodes(block)
		.map((t) => t.data)
		.join('');
}

function snapUtf16(text: string, offset: number): number {
	if (offset <= 0) return 0;
	if (offset >= text.length) return text.length;
	if (isLowSurrogate(text.charCodeAt(offset)) && isHighSurrogate(text.charCodeAt(offset - 1))) {
		return offset - 1;
	}
	return offset;
}

function plaintextOffsetFromDom(block: HTMLElement, node: Node, offset: number): number {
	const widget = widgetRoot(node);
	if (widget && widget !== block && block.contains(widget)) {
		return plaintextBeforeNode(block, widget);
	}

	if (node.nodeType === Node.TEXT_NODE) {
		const text = node as Text;
		return plaintextBeforeNode(block, text) + snapUtf16(text.data, offset);
	}

	if (node.nodeType === Node.ELEMENT_NODE) {
		const el = node as Element;
		let total = el === block ? 0 : plaintextBeforeNode(block, el);
		const kids = el.childNodes;
		const upTo = Math.max(0, Math.min(offset, kids.length));
		for (let i = 0; i < upTo; i++) total += documentTextIn(kids[i]);
		return total;
	}

	return plaintextBeforeNode(block, node);
}

export function pointFromDom(host: HTMLElement, node: Node, offset: number): Point | null {
	const block = closestBlock(node, host);
	if (!block) return null;
	const blockId = block.getAttribute(BLOCK_ID_ATTR);
	if (!blockId) return null;
	const textOffset = plaintextOffsetFromDom(block, node, offset);
	return { blockId, offset: textOffset };
}

export function rangeFromEndpoints(
	host: HTMLElement,
	anchorNode: Node,
	anchorOffset: number,
	focusNode: Node,
	focusOffset: number
): Range | null {
	const anchor = pointFromDom(host, anchorNode, anchorOffset);
	const head = pointFromDom(host, focusNode, focusOffset);
	if (!anchor || !head) return null;
	return { anchor, head };
}

export function rangeFromSelection(host: HTMLElement, sel: Selection | null = null): Range | null {
	const selection = sel ?? host.ownerDocument.getSelection();
	if (!selection || selection.rangeCount === 0) return null;
	if (!selection.anchorNode || !selection.focusNode) return null;
	return rangeFromEndpoints(
		host,
		selection.anchorNode,
		selection.anchorOffset,
		selection.focusNode,
		selection.focusOffset
	);
}

export function rangeFromInputEvent(host: HTMLElement, event: InputEvent, fallback: Range): Range {
	try {
		if (typeof event.getTargetRanges === 'function') {
			const ranges = event.getTargetRanges();
			if (ranges.length > 0) {
				const r = ranges[0];
				const mapped = rangeFromEndpoints(
					host,
					r.startContainer,
					r.startOffset,
					r.endContainer,
					r.endOffset
				);
				if (mapped) return mapped;
			}
		}
	} catch {
		// jsdom may not implement getTargetRanges
	}
	return rangeFromSelection(host) ?? fallback;
}

export function nodeAtOffset(block: HTMLElement, offset: number): { node: Text; offset: number } | null {
	const texts = textNodes(block);
	if (texts.length === 0) return null;
	let remaining = Math.max(0, offset);
	for (let i = 0; i < texts.length; i++) {
		const text = texts[i];
		const len = text.data.length;
		if (remaining < len || (remaining === len && i === texts.length - 1)) {
			return { node: text, offset: snapUtf16(text.data, remaining) };
		}
		remaining -= len;
	}
	const last = texts[texts.length - 1];
	return { node: last, offset: last.data.length };
}

export function restoreSelection(host: HTMLElement, range: Range, page?: KbPage): void {
	const doc = host.ownerDocument;
	const sel = doc.getSelection();
	if (!sel) return;

	const clamp = page ? clampRange(page, range) : range;
	const anchorBlock = host.querySelector(`[${BLOCK_ID_ATTR}="${cssEscape(clamp.anchor.blockId)}"]`) as HTMLElement | null;
	const headBlock = host.querySelector(`[${BLOCK_ID_ATTR}="${cssEscape(clamp.head.blockId)}"]`) as HTMLElement | null;
	if (!anchorBlock || !headBlock) return;

	const anchor = nodeAtOffset(anchorBlock, clamp.anchor.offset);
	const head = nodeAtOffset(headBlock, clamp.head.offset);

	sel.removeAllRanges();
	const domRange = doc.createRange();
	if (anchor && head) {
		try {
			domRange.setStart(anchor.node, anchor.offset);
			domRange.collapse(true);
			sel.addRange(domRange);
			if (
				clamp.anchor.blockId !== clamp.head.blockId ||
				clamp.anchor.offset !== clamp.head.offset
			) {
				sel.extend(head.node, head.offset);
			}
		} catch {
			domRange.setStart(anchor.node, anchor.offset);
			domRange.collapse(true);
			sel.addRange(domRange);
		}
		return;
	}

	const target = anchorBlock;
	domRange.selectNodeContents(target);
	domRange.collapse(clamp.anchor.offset === 0);
	sel.addRange(domRange);
}

function cssEscape(value: string): string {
	if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
	return value.replace(/"/g, '\\"');
}

export function caretIn(page: KbPage, blockId: string, offset: number): Range {
	const block = findBlock(page, blockId);
	if (!block) {
		const first = documentOrder(page)[0];
		if (!first) return collapsed({ blockId, offset: 0 });
		return collapsed({ blockId: first.id, offset: 0 });
	}
	const len = plaintextOf(block).length;
	return collapsed({ blockId, offset: Math.max(0, Math.min(offset, len)) });
}
