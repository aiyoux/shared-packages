import {
	documentOrder,
	findBlock,
	isAtomic,
	parentOf,
	plaintextOf,
	type KbPage,
	type Point,
	type Range
} from '@shared-packages/kb-model';

export function isCollapsed(range: Range): boolean {
	return range.anchor.blockId === range.head.blockId && range.anchor.offset === range.head.offset;
}

export function collapsed(point: Point): Range {
	return { anchor: { ...point }, head: { ...point } };
}

/** DFS document-order index, or -1 if missing. */
export function blockIndex(page: KbPage, id: string): number {
	return documentOrder(page).findIndex((block) => block.id === id);
}

export function requireBlock(page: KbPage, id: string) {
	const block = findBlock(page, id);
	const loc = parentOf(page, id);
	if (!block || !loc) throw new Error(`unknown block ${id}`);
	return { block, parent: loc.parent, index: loc.index };
}

/** Document-order start/end. Does not throw on missing ids; missing sorts last. */
export function orderedRange(page: KbPage, range: Range): { start: Point; end: Point } {
	const ai = blockIndex(page, range.anchor.blockId);
	const hi = blockIndex(page, range.head.blockId);
	if (ai < 0 && hi < 0) return { start: range.anchor, end: range.head };
	if (ai < 0) return { start: range.head, end: range.head };
	if (hi < 0) return { start: range.anchor, end: range.anchor };
	if (ai < hi || (ai === hi && range.anchor.offset <= range.head.offset)) {
		return { start: range.anchor, end: range.head };
	}
	return { start: range.head, end: range.anchor };
}

export function payloadLength(page: KbPage, blockId: string): number {
	const block = findBlock(page, blockId);
	return block ? plaintextOf(block).length : 0;
}

export function clampPoint(page: KbPage, point: Point): Point {
	const block = findBlock(page, point.blockId);
	if (!block) {
		const first = documentOrder(page)[0];
		if (!first) return { blockId: point.blockId, offset: 0 };
		return { blockId: first.id, offset: 0 };
	}
	if (isAtomic(block)) return { blockId: block.id, offset: 0 };
	const len = plaintextOf(block).length;
	return { blockId: block.id, offset: Math.max(0, Math.min(point.offset, len)) };
}

export function clampRange(page: KbPage, range: Range): Range {
	return { anchor: clampPoint(page, range.anchor), head: clampPoint(page, range.head) };
}
