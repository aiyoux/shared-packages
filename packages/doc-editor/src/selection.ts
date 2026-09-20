import {
	documentOrder,
	findBlock,
	isHighSurrogate,
	isLowSurrogate,
	isTextLike,
	plaintextOf,
	type Block,
	type KbPage,
	type Point,
	type Range
} from '@shared-packages/doc-model';
import { BLOCK_ID_ATTR, BLOCK_TYPE_ATTR } from './project.js';
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

/**
 * Live `Selection` first, `getTargetRanges()` only as a fallback when no
 * selection resolves inside `host`.
 *
 * Chrome can keep a `getTargetRanges()` snapshot stale for one event after a
 * programmatic `Selection.addRange()` — exactly what `restoreSelection` does
 * after every op, e.g. Enter placing the caret in a freshly split block: the
 * *next* `beforeinput` reports target ranges still pointing at the
 * pre-split caret, while `document.getSelection()` already reflects the
 * restored one correctly. Trusting target ranges there silently redirected
 * typed text into the old block. `getTargetRanges()` stays as the fallback
 * for the rare case host has focus but no resolvable live selection.
 */
export function rangeFromInputEvent(host: HTMLElement, event: InputEvent, fallback: Range): Range {
	const live = rangeFromSelection(host);
	if (live) return live;
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
	return fallback;
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

/**
 * Whether a text field outside `host` currently holds focus.
 *
 * `restoreSelection` ends in `Selection.addRange` inside the contenteditable,
 * and that focuses the host as a side effect. While the user is editing the
 * document that is exactly right. But a repaint can be driven by something the
 * user is not looking at — a page loading in another pane, a collab frame
 * arriving — and then re-asserting the caret yanks focus out of whatever they
 * are actually typing in. The tree's inline rename input lost every keystroke
 * this way: it opened, the page finished loading, the repaint stole focus, and
 * the input's blur handler committed the edit away.
 *
 * Focus sitting on the body or on a button is fine to take; another text field
 * is not.
 */
export function focusHeldOutside(host: HTMLElement): boolean {
	const active = host.ownerDocument.activeElement as HTMLElement | null;
	if (!active || active === host.ownerDocument.body) return false;
	if (host.contains(active)) return false;
	// `isContentEditable` covers descendants that inherit editability; the
	// attribute is the fallback for environments that do not implement it.
	if (active.isContentEditable) return true;
	const editable = active.getAttribute('contenteditable');
	if (editable === '' || editable === 'true') return true;
	return active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT';
}

export function restoreSelection(host: HTMLElement, range: Range, page?: KbPage): void {
	const doc = host.ownerDocument;
	const sel = doc.getSelection();
	if (!sel) return;

	const clamp = page ? clampRange(page, range) : range;
	const current = rangeFromSelection(host);
	if (
		current &&
		current.anchor.blockId === clamp.anchor.blockId &&
		current.anchor.offset === clamp.anchor.offset &&
		current.head.blockId === clamp.head.blockId &&
		current.head.offset === clamp.head.offset
	) {
		return;
	}
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

/** One visual line of a text-like block, in viewport coordinates. */
export type LineBox = {
	top: number;
	bottom: number;
	left: number;
	right: number;
	startOffset: number;
	endOffset: number;
	glyphs?: { offset: number; left: number; right: number }[];
};

const TRAILING_CLICK_SLACK_PX = 1;

export function isTextCaretBlockType(type: string | null): boolean {
	return (
		type === 'paragraph' ||
		type === 'heading' ||
		type === 'list_item' ||
		type === 'code' ||
		type === 'table_cell'
	);
}

function verticalDist(top: number, bottom: number, clientY: number): number {
	if (clientY < top) return top - clientY;
	if (clientY > bottom) return clientY - bottom;
	return 0;
}

function blockPlainLength(block: HTMLElement): number {
	let n = 0;
	for (const text of textNodes(block)) n += text.data.length;
	return n;
}

/**
 * Glyph boxes for a block, grouped into visual lines.
 *
 * Used to snap a click in the empty space to the right of a line to that
 * line's end — native contenteditable only does this when the caret is
 * already in the block.
 */
export function lineBoxesOf(block: HTMLElement): LineBox[] {
	const texts = textNodes(block);
	const doc = block.ownerDocument;
	const lines: LineBox[] = [];
	let offset = 0;
	for (const text of texts) {
		const len = text.data.length;
		for (let i = 0; i < len; i++) {
			const range = doc.createRange();
			try {
				range.setStart(text, i);
				range.setEnd(text, i + 1);
			} catch {
				continue;
			}
			const rect = range.getClientRects()[0];
			if (!rect || (rect.width === 0 && rect.height === 0)) continue;
			const midY = rect.top + rect.height / 2;
			const glyph = { offset: offset + i, left: rect.left, right: rect.right };
			let line = lines.find((l) => midY >= l.top && midY <= l.bottom);
			if (!line) {
				lines.push({
					top: rect.top,
					bottom: rect.bottom,
					left: rect.left,
					right: rect.right,
					startOffset: offset + i,
					endOffset: offset + i + 1,
					glyphs: [glyph]
				});
			} else {
				line.top = Math.min(line.top, rect.top);
				line.bottom = Math.max(line.bottom, rect.bottom);
				line.left = Math.min(line.left, rect.left);
				line.right = Math.max(line.right, rect.right);
				line.startOffset = Math.min(line.startOffset, offset + i);
				line.endOffset = Math.max(line.endOffset, offset + i + 1);
				(line.glyphs ??= []).push(glyph);
			}
		}
		offset += len;
	}
	return lines;
}

export function lineBoxAtY(lines: LineBox[], clientY: number): LineBox | null {
	if (lines.length === 0) return null;
	let best = lines[0]!;
	let bestDist = Infinity;
	for (const line of lines) {
		const dist =
			clientY < line.top ? line.top - clientY : clientY > line.bottom ? clientY - line.bottom : 0;
		if (dist < bestDist) {
			bestDist = dist;
			best = line;
		}
	}
	return best;
}

/**
 * Caret offset on a visual line for a viewport x. Clicks in the line-height
 * padding above/below glyphs used to snap to `startOffset` because they
 * missed the glyph boxes; this keeps the x the user actually pointed at.
 */
export function offsetAlongLine(line: LineBox, clientX: number): number {
	if (clientX <= line.left) return line.startOffset;
	if (clientX >= line.right) return line.endOffset;
	const glyphs = line.glyphs ?? [];
	if (!glyphs.length) return line.startOffset;
	for (const g of glyphs) {
		if (clientX < g.right) {
			const mid = (g.left + g.right) / 2;
			return clientX < mid ? g.offset : g.offset + 1;
		}
	}
	return line.endOffset;
}

/**
 * The innermost text-like block under a viewport point, including clicks
 * that land to the right of shrink-wrapped content (target is the host).
 */
export function blockElementFromClient(host: HTMLElement, clientX: number, clientY: number): HTMLElement | null {
	const doc = host.ownerDocument;
	if (typeof doc.elementsFromPoint === 'function') {
		for (const node of doc.elementsFromPoint(clientX, clientY)) {
			if (!(node instanceof HTMLElement)) continue;
			if (node !== host && !host.contains(node)) continue;
			const block = node.closest(`[${BLOCK_ID_ATTR}]`);
			if (block instanceof HTMLElement && host.contains(block) && isTextCaretBlockType(block.getAttribute(BLOCK_TYPE_ATTR))) {
				return block;
			}
		}
	}
	let best: HTMLElement | null = null;
	let bestArea = Infinity;
	for (const node of host.querySelectorAll(`[${BLOCK_ID_ATTR}]`)) {
		if (!(node instanceof HTMLElement)) continue;
		if (!isTextCaretBlockType(node.getAttribute(BLOCK_TYPE_ATTR))) continue;
		const rect = node.getBoundingClientRect();
		if (clientY < rect.top || clientY > rect.bottom) continue;
		if (clientX < rect.left) continue;
		const area = Math.max(rect.width, 1) * Math.max(rect.height, 1);
		if (area < bestArea) {
			bestArea = area;
			best = node;
		}
	}
	return best;
}

/**
 * Text-like block under the point, or the nearest one when the point sits in
 * a margin gap / the empty space below the last block. Native CE and
 * `elementsFromPoint` both miss those.
 */
export function textBlockNearestToClient(
	host: HTMLElement,
	clientX: number,
	clientY: number
): HTMLElement | null {
	const exact = blockElementFromClient(host, clientX, clientY);
	if (exact) return exact;
	let best: HTMLElement | null = null;
	let bestDist = Infinity;
	let bestArea = Infinity;
	let bestInColumn = false;
	for (const node of host.querySelectorAll(`[${BLOCK_ID_ATTR}]`)) {
		if (!(node instanceof HTMLElement)) continue;
		if (!isTextCaretBlockType(node.getAttribute(BLOCK_TYPE_ATTR))) continue;
		const rect = node.getBoundingClientRect();
		if (clientX < rect.left) continue;
		const inColumn = clientX <= rect.right;
		const dist = verticalDist(rect.top, rect.bottom, clientY);
		const area = Math.max(rect.width, 1) * Math.max(rect.height, 1);
		if (inColumn !== bestInColumn) {
			if (!inColumn && bestInColumn) continue;
			best = node;
			bestDist = dist;
			bestArea = area;
			bestInColumn = inColumn;
			continue;
		}
		if (dist < bestDist || (dist === bestDist && area < bestArea)) {
			bestDist = dist;
			bestArea = area;
			best = node;
		}
	}
	return best;
}

/**
 * True when the point sits on a rendered glyph. Native contenteditable starts
 * a drag-select from those hits (and owns double-click word select); empty
 * space, empty lines, and inter-block gaps do not.
 */
export function isPointOnGlyph(host: HTMLElement, clientX: number, clientY: number): boolean {
	const hit = caretRangeFromPoint(host.ownerDocument, clientX, clientY);
	if (
		hit &&
		hit.node.nodeType === Node.TEXT_NODE &&
		host.contains(hit.node) &&
		!inCollabWidget(hit.node)
	) {
		const text = hit.node as Text;
		const doc = host.ownerDocument;
		for (const i of [hit.offset, hit.offset - 1]) {
			if (i < 0 || i >= text.data.length) continue;
			const range = doc.createRange();
			try {
				range.setStart(text, i);
				range.setEnd(text, i + 1);
			} catch {
				continue;
			}
			for (const rect of Array.from(range.getClientRects())) {
				if (
					clientX >= rect.left &&
					clientX <= rect.right &&
					clientY >= rect.top &&
					clientY <= rect.bottom
				) {
					return true;
				}
			}
		}
	}
	const block = blockElementFromClient(host, clientX, clientY);
	if (!block) return false;
	const line = lineBoxesOf(block).find((l) => clientY >= l.top && clientY <= l.bottom);
	if (!line) return false;
	return clientX >= line.left && clientX <= line.right;
}

/**
 * Caret for a hit that is not on a glyph: trailing/leading empty space on a
 * line, an empty block, an empty visual line (hard break / extra block
 * height), or a gap between blocks.
 */
export function nearestEmptyCaretFromClient(
	host: HTMLElement,
	clientX: number,
	clientY: number
): Point | null {
	const block = textBlockNearestToClient(host, clientX, clientY);
	if (!block) return null;
	const blockId = block.getAttribute(BLOCK_ID_ATTR);
	if (!blockId) return null;
	const lines = lineBoxesOf(block);
	if (lines.length === 0) return { blockId, offset: 0 };
	const line = lineBoxAtY(lines, clientY);
	if (!line) return { blockId, offset: 0 };
	if (clientX > line.right + TRAILING_CLICK_SLACK_PX) {
		const last = lines[lines.length - 1]!;
		const offset =
			clientY > last.bottom ? Math.max(last.endOffset, blockPlainLength(block)) : line.endOffset;
		return { blockId, offset };
	}
	if (clientX < line.left - TRAILING_CLICK_SLACK_PX) {
		return { blockId, offset: line.startOffset };
	}
	const onLine = clientY >= line.top && clientY <= line.bottom;
	if (onLine) return null;
	const glyphH = Math.max(1, line.bottom - line.top);
	const nearLine =
		clientY >= line.top - glyphH * 0.45 && clientY <= line.bottom + glyphH * 0.45;
	const blockRect = block.getBoundingClientRect();
	const insideBlock = clientY >= blockRect.top && clientY <= blockRect.bottom;
	if (nearLine && insideBlock) {
		return { blockId, offset: offsetAlongLine(line, clientX) };
	}
	if (clientY > line.bottom) {
		const last = lines[lines.length - 1]!;
		const offset =
			clientY > last.bottom ? Math.max(last.endOffset, blockPlainLength(block)) : line.endOffset;
		return { blockId, offset };
	}
	return { blockId, offset: line.startOffset };
}

/**
 * When the click is in the empty space past the last glyph on a line, the
 * caret belongs at that line's end. Returns null when native placement in
 * the glyphs should stand (including mid-text clicks on an inactive block).
 */
export function trailingLineEndFromClient(
	host: HTMLElement,
	clientX: number,
	clientY: number
): Point | null {
	const block = blockElementFromClient(host, clientX, clientY);
	if (!block) return null;
	const blockId = block.getAttribute(BLOCK_ID_ATTR);
	if (!blockId) return null;
	const lines = lineBoxesOf(block);
	if (lines.length === 0) {
		const rect = block.getBoundingClientRect();
		if (clientY < rect.top || clientY > rect.bottom) return null;
		return { blockId, offset: 0 };
	}
	const line = lineBoxAtY(lines, clientY);
	if (!line) return null;
	if (clientX > line.right + TRAILING_CLICK_SLACK_PX) {
		return { blockId, offset: line.endOffset };
	}
	return null;
}

/**
 * Click in the empty space to the left of a line (padding / indent) belongs
 * at that line's start.
 */
export function lineStartFromClient(
	host: HTMLElement,
	clientX: number,
	clientY: number
): Point | null {
	const block = blockElementFromClient(host, clientX, clientY);
	if (!block) return null;
	const blockId = block.getAttribute(BLOCK_ID_ATTR);
	if (!blockId) return null;
	const lines = lineBoxesOf(block);
	if (lines.length === 0) return null;
	const line = lineBoxAtY(lines, clientY);
	if (!line) return null;
	if (clientX < line.left - TRAILING_CLICK_SLACK_PX) {
		return { blockId, offset: line.startOffset };
	}
	return null;
}

function caretRangeFromPoint(doc: Document, clientX: number, clientY: number): { node: Node; offset: number } | null {
	const anyDoc = doc as Document & {
		caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
		caretRangeFromPoint?: (x: number, y: number) => globalThis.Range | null;
	};
	if (typeof anyDoc.caretPositionFromPoint === 'function') {
		const pos = anyDoc.caretPositionFromPoint(clientX, clientY);
		if (pos?.offsetNode) return { node: pos.offsetNode, offset: pos.offset };
	}
	if (typeof anyDoc.caretRangeFromPoint === 'function') {
		const range = anyDoc.caretRangeFromPoint(clientX, clientY);
		if (range?.startContainer) return { node: range.startContainer, offset: range.startOffset };
	}
	return null;
}

/**
 * Map a viewport point to a document caret. Empty space (after text, empty
 * lines, gaps) snaps via line boxes; glyph hits use `caretPositionFromPoint`.
 */
/**
 * Native CE already places the caret when the hit is a real text glyph.
 * Element hits (a mark wrapper at offset 0) and line-height padding do not —
 * those used to land at the start of the span or line.
 */
export function isNativeTextGlyphHit(host: HTMLElement, clientX: number, clientY: number): boolean {
	if (!isPointOnGlyph(host, clientX, clientY)) return false;
	const hit = caretRangeFromPoint(host.ownerDocument, clientX, clientY);
	return Boolean(
		hit &&
			hit.node.nodeType === Node.TEXT_NODE &&
			host.contains(hit.node) &&
			!inCollabWidget(hit.node)
	);
}

export function caretFromClient(host: HTMLElement, clientX: number, clientY: number): Point | null {
	if (!isPointOnGlyph(host, clientX, clientY)) {
		const empty = nearestEmptyCaretFromClient(host, clientX, clientY);
		if (empty) return empty;
	}
	const hit = caretRangeFromPoint(host.ownerDocument, clientX, clientY);
	if (hit) {
		if (hit.node.nodeType === Node.ELEMENT_NODE) {
			const empty = nearestEmptyCaretFromClient(host, clientX, clientY);
			if (empty) return empty;
		}
		const root = hit.node.nodeType === Node.ELEMENT_NODE ? hit.node : hit.node.parentNode;
		if (root && host.contains(root)) {
			const mapped = pointFromDom(host, hit.node, hit.offset);
			if (mapped) return mapped;
		}
	}
	return nearestEmptyCaretFromClient(host, clientX, clientY);
}

/** Empty-space click that native CE would not place correctly. */
export function emptySpaceCaretFromClient(
	host: HTMLElement,
	clientX: number,
	clientY: number
): Point | null {
	if (isPointOnGlyph(host, clientX, clientY)) return null;
	return nearestEmptyCaretFromClient(host, clientX, clientY);
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

/** Blocks a caret may rest in only when they hold content — an empty one of
 *  these projects to a block with a single empty text node, which has no
 *  inline box, so the browser's caret traversal jumps straight over it. */
function isEmptyCaretBlock(block: Block | undefined): boolean {
	if (!block) return false;
	if (isTextLike(block)) return plaintextOf(block).length === 0;
	if (block.type === 'code') return block.text.length === 0;
	return false;
}

/**
 * ArrowUp/ArrowDown must stop in empty blocks.
 *
 * Native caret traversal skips a block whose only content is an empty text
 * node (there is no inline box for the caret to rest on), so pressing Down
 * over a run of empty lines jumps the whole run. When the selection's focus
 * sits on its block's boundary line and the adjacent block is empty, steer
 * into it ourselves; every other case native movement already gets right
 * (mid-block line steps, non-empty neighbours, document edges).
 *
 * Returns the selection to apply, or null to let the browser move.
 */
export function verticalArrowSelection(
	host: HTMLElement,
	page: KbPage,
	key: 'ArrowUp' | 'ArrowDown',
	live: Range,
	extend: boolean
): Range | null {
	const down = key === 'ArrowDown';
	const el = host.querySelector(`[${BLOCK_ID_ATTR}="${cssEscape(live.head.blockId)}"]`);
	if (!(el instanceof HTMLElement)) return null;
	if (!onBoundaryLine(el, down)) return null;
	const adjacent = down ? el.nextElementSibling : el.previousElementSibling;
	if (!(adjacent instanceof HTMLElement) || !adjacent.hasAttribute(BLOCK_ID_ATTR)) return null;
	const adjId = adjacent.getAttribute(BLOCK_ID_ATTR) as string;
	if (!isEmptyCaretBlock(findBlock(page, adjId))) return null;
	const head: Point = { blockId: adjId, offset: 0 };
	return extend ? { anchor: { ...live.anchor }, head } : collapsed(head);
}

/** Is the focus on the block's first (up) or last (down) visual line? The
 *  native arrows only misbehave at a block boundary, where they would leave
 *  the block; inside it Chromium steps line by line and must be left alone. */
function onBoundaryLine(blockEl: HTMLElement, down: boolean): boolean {
	const sel = blockEl.ownerDocument.getSelection();
	if (!sel || sel.rangeCount === 0) return true;
	const range = sel.getRangeAt(0);
	// Non-layout environments (jsdom) have no client rects: nothing says the
	// caret is mid-block, so treat it as a boundary line.
	if (typeof range.getClientRects !== 'function') return true;
	const rects = range.getClientRects();
	const line = down ? rects[rects.length - 1] : rects[0];
	// No rect (e.g. the focus is an empty block, or an unrendered selection):
	// treat as a single boundary line.
	if (!line || line.height === 0) return true;
	const blockRect = blockEl.getBoundingClientRect();
	// Half a line of slack: code blocks pad their content by 0.5rem, so the
	// first/last line never touches the border box.
	return down
		? blockRect.bottom - line.bottom <= line.height / 2
		: line.top - blockRect.top <= line.height / 2;
}
