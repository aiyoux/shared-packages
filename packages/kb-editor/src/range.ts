import {
	blockChildren,
	documentOrder,
	findBlock,
	isDescendant,
	isNonTextual,
	isTextLike,
	locateBlock,
	parentIdOf,
	parentOf,
	plaintextOf,
	sameParent,
	visibleOrder,
	type KbPage,
	type Op,
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
	const loc = locateBlock(page, id);
	if (!loc) throw new Error(`unknown block ${id}`);
	return loc;
}

export function rangeSharesParent(page: KbPage, range: Range): boolean {
	if (isCollapsed(range)) return true;
	const a = parentOf(page, range.anchor.blockId);
	const b = parentOf(page, range.head.blockId);
	if (!a || !b) return false;
	return sameParent(a.parent, b.parent);
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

export function parentIdFor(page: KbPage, blockId: string): string | null {
	const loc = parentOf(page, blockId);
	if (!loc) return null;
	return parentIdOf(loc.parent);
}

function closedToggleAncestor(page: KbPage, id: string): string | null {
	let current = id;
	for (;;) {
		const loc = parentOf(page, current);
		if (!loc) return null;
		if (loc.parent !== 'page' && loc.parent.type === 'toggle' && loc.parent.open === false) {
			return loc.parent.id;
		}
		if (loc.parent === 'page') return null;
		current = loc.parent.id;
	}
}

export function clampPoint(page: KbPage, point: Point): Point {
	const visible = visibleOrder(page);
	const block = findBlock(page, point.blockId);
	if (!block) {
		const first = visible[0] ?? documentOrder(page)[0];
		if (!first) return { blockId: point.blockId, offset: 0 };
		return { blockId: first.id, offset: 0 };
	}
	if (!visible.some((item) => item.id === block.id)) {
		const toggleId = closedToggleAncestor(page, block.id);
		if (toggleId) return { blockId: toggleId, offset: 0 };
		const first = visible[0];
		if (!first) return { blockId: block.id, offset: 0 };
		return { blockId: first.id, offset: 0 };
	}
	if (isNonTextual(block)) return { blockId: block.id, offset: 0 };
	const len = plaintextOf(block).length;
	return { blockId: block.id, offset: Math.max(0, Math.min(point.offset, len)) };
}

export function clampRange(page: KbPage, range: Range): Range {
	return { anchor: clampPoint(page, range.anchor), head: clampPoint(page, range.head) };
}

/** True when the document-order start is a container that contains the end (illegal for apply). */
export function rangeStartsOnAncestor(page: KbPage, range: Range): boolean {
	if (isCollapsed(range)) return false;
	const { start, end } = orderedRange(page, range);
	return isDescendant(page, start.blockId, end.blockId);
}

/** Skip chrome→descendant ranges that apply would throw on. */
export function deleteRangeOps(page: KbPage, range: Range): Op[] {
	if (isCollapsed(range) || rangeStartsOnAncestor(page, range)) return [];
	return [{ kind: 'delete-range', range }];
}

/**
 * Caret for insert-text. Container/atomic chrome is not a text target:
 * first text-like/code child, else null (caller no-ops).
 */
export function textInsertPoint(page: KbPage, point: Point): Point | null {
	const block = findBlock(page, point.blockId);
	if (!block) return null;
	if (isTextLike(block) || block.type === 'code') {
		return { blockId: block.id, offset: point.offset };
	}
	if (!isNonTextual(block)) return null;
	const kids = blockChildren(block) ?? [];
	const first = kids.find((kid) => isTextLike(kid) || kid.type === 'code');
	if (!first) return null;
	return { blockId: first.id, offset: 0 };
}
