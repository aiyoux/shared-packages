import { convertBlock, normalizeRange } from './apply.js';
import { isAtomic, isTextLike, plaintextOf } from './plaintext.js';
import { blockChildren, documentOrder, findBlock, locateBlock, sameParent, visibleOrder } from './tree.js';
import type { Block, KbPage, Op, Point, Range } from './types.js';
import { snapOffset } from './utf16.js';

/** -1 stick before (default); 0 insert-shifts / split-stays; 1 stick after. */
export type Assoc = -1 | 0 | 1;

export type StickyPoint = Point & { assoc?: Assoc };

function assocOf(point: StickyPoint): Assoc {
	return point.assoc === 0 || point.assoc === 1 ? point.assoc : -1;
}

function keep(point: StickyPoint, blockId: string, offset: number, assoc?: Assoc): StickyPoint {
	const nextAssoc = assoc ?? point.assoc;
	return nextAssoc === undefined ? { blockId, offset } : { blockId, offset, assoc: nextAssoc };
}

function payload(block: Block): string {
	if (isTextLike(block) || block.type === 'code') return plaintextOf(block);
	return '';
}

function canTakeText(block: Block): boolean {
	return isTextLike(block) || block.type === 'code';
}

function canConcat(start: Block, end: Block): boolean {
	return canTakeText(start) && canTakeText(end);
}

function isCodeEmptyLastLine(block: Block, offset: number): boolean {
	return block.type === 'code' && offset === block.text.length && (block.text === '' || block.text.endsWith('\n'));
}

function collectSubtreeIds(block: Block, into: string[] = []): string[] {
	into.push(block.id);
	const kids = blockChildren(block);
	if (kids) for (const child of kids) collectSubtreeIds(child, into);
	return into;
}

function isInSubtree(page: KbPage, ancestorId: string, id: string): boolean {
	if (ancestorId === id) return true;
	const ancestor = findBlock(page, ancestorId);
	if (!ancestor) return false;
	return collectSubtreeIds(ancestor).includes(id);
}

/**
 * Remap a caret/awareness point through one Op against the page *before* that op.
 * `null` means the target was deleted — caller snaps (never throw on the remote path).
 * Nested/table ops extend this table in N1/N3.
 */
export function mapPointThroughOp(pageBefore: KbPage, point: StickyPoint, op: Op): StickyPoint | null {
	switch (op.kind) {
		case 'set-title':
		case 'set-children':
		case 'format-range':
		case 'insert-block':
		case 'move-block':
			return point;
		case 'insert-text':
			return mapInsertText(pageBefore, point, op);
		case 'delete-range':
			return mapDeleteRange(pageBefore, point, op);
		case 'split-block':
			return mapSplitBlock(pageBefore, point, op);
		case 'merge-block':
			return mapMergeBlock(pageBefore, point, op);
		case 'delete-block':
			return mapDeleteBlock(pageBefore, point, op);
		case 'convert-block':
			return mapConvertBlock(pageBefore, point, op);
		case 'set-code':
			return mapSetCode(pageBefore, point, op);
		default: {
			const _never: never = op;
			void _never;
			return point;
		}
	}
}

function mapInsertText(
	page: KbPage,
	point: StickyPoint,
	op: Extract<Op, { kind: 'insert-text' }>
): StickyPoint {
	if (point.blockId !== op.at.blockId || op.text.length === 0) return point;
	const block = findBlock(page, point.blockId);
	if (!block || !canTakeText(block)) return point;
	const text = payload(block);
	const at = op.at.offset;
	let offset = snapOffset(text, point.offset);
	if (offset > at || (offset === at && assocOf(point) >= 0)) {
		const next = text.slice(0, at) + op.text + text.slice(at);
		offset = snapOffset(next, offset + op.text.length);
	}
	return keep(point, point.blockId, offset);
}

function mapDeleteRange(
	page: KbPage,
	point: StickyPoint,
	op: Extract<Op, { kind: 'delete-range' }>
): StickyPoint | null {
	let start: ReturnType<typeof normalizeRange>['start'];
	let end: ReturnType<typeof normalizeRange>['end'];
	try {
		({ start, end } = normalizeRange(page, op.range));
	} catch {
		return point;
	}
	if (start.block.id === end.block.id && start.offset === end.offset) return point;

	if (start.block.id === end.block.id) {
		if (point.blockId !== start.block.id) return point;
		const from = start.offset;
		const to = end.offset;
		const text = payload(start.block);
		const offset = snapOffset(text, point.offset);
		if (offset < from) return keep(point, point.blockId, offset);
		if (offset < to) return keep(point, point.blockId, from, -1);
		const remaining = text.slice(0, from) + text.slice(to);
		return keep(point, point.blockId, snapOffset(remaining, offset - (to - from)));
	}

	// v1 apply throws on different parents — mapping is not called for a dropped op.
	if (!sameParent(start.parent, end.parent)) return point;

	const order = documentOrder(page);
	const si = order.findIndex((block) => block.id === start.block.id);
	const ei = order.findIndex((block) => block.id === end.block.id);
	if (si < 0 || ei < 0) return point;
	for (let i = si + 1; i < ei; i++) {
		if (order[i].id === point.blockId) return null;
	}

	if (canConcat(start.block, end.block)) {
		if (point.blockId === start.block.id) {
			const offset = snapOffset(payload(start.block), point.offset);
			return keep(point, start.block.id, Math.min(offset, start.offset));
		}
		if (point.blockId === end.block.id) {
			const offset = snapOffset(payload(end.block), point.offset);
			if (offset < end.offset) return keep(point, start.block.id, start.offset, -1);
			const joined = payload(start.block).slice(0, start.offset) + payload(end.block).slice(end.offset);
			return keep(point, start.block.id, snapOffset(joined, start.offset + (offset - end.offset)));
		}
		return point;
	}

	if (point.blockId === start.block.id) {
		if (isAtomic(start.block)) return null;
		const offset = snapOffset(payload(start.block), point.offset);
		return keep(point, start.block.id, Math.min(offset, start.offset));
	}
	if (point.blockId === end.block.id) {
		if (isAtomic(end.block) && end.offset > 0) return null;
		if (isAtomic(end.block)) return keep(point, end.block.id, 0);
		const offset = snapOffset(payload(end.block), point.offset);
		if (offset < end.offset) return keep(point, end.block.id, 0, -1);
		const suffix = payload(end.block).slice(end.offset);
		return keep(point, end.block.id, snapOffset(suffix, offset - end.offset));
	}
	return point;
}

function mapSplitBlock(
	page: KbPage,
	point: StickyPoint,
	op: Extract<Op, { kind: 'split-block' }>
): StickyPoint {
	if (point.blockId !== op.at.blockId) return point;
	if (locateBlock(page, op.newId)) return point;
	const loc = locateBlock(page, op.at.blockId);
	if (!loc) return point;
	const block = loc.block;
	if (isAtomic(block) || !canTakeText(block)) return point;
	if (block.type === 'code' && !isCodeEmptyLastLine(block, op.at.offset)) return point;
	const text = payload(block);
	const at = op.at.offset;
	const offset = snapOffset(text, point.offset);
	if (offset < at) return keep(point, point.blockId, offset);
	if (offset === at) {
		// assoc < 1 (incl. 0 / default) stays on the old block; assoc 1 follows newId.
		if (assocOf(point) === 1) return keep(point, op.newId, 0);
		return keep(point, point.blockId, offset);
	}
	const tail = text.slice(at);
	return keep(point, op.newId, snapOffset(tail, offset - at));
}

function mapMergeBlock(
	page: KbPage,
	point: StickyPoint,
	op: Extract<Op, { kind: 'merge-block' }>
): StickyPoint | null {
	if (op.keepId === op.dropId) return point;
	const keepLoc = locateBlock(page, op.keepId);
	const dropLoc = locateBlock(page, op.dropId);
	if (!keepLoc || !dropLoc) return point;
	if (!sameParent(keepLoc.parent, dropLoc.parent) || dropLoc.index !== keepLoc.index + 1) return point;
	if (isAtomic(keepLoc.block)) return point;
	if (point.blockId === op.keepId) return point;
	if (point.blockId !== op.dropId) return point;
	if (isAtomic(dropLoc.block)) return null;
	const keepLen = payload(keepLoc.block).length;
	const joined = payload(keepLoc.block) + payload(dropLoc.block);
	return keep(point, op.keepId, snapOffset(joined, keepLen + snapOffset(payload(dropLoc.block), point.offset)));
}

function mapDeleteBlock(
	page: KbPage,
	point: StickyPoint,
	op: Extract<Op, { kind: 'delete-block' }>
): StickyPoint | null {
	return isInSubtree(page, op.id, point.blockId) ? null : point;
}

function mapConvertBlock(
	page: KbPage,
	point: StickyPoint,
	op: Extract<Op, { kind: 'convert-block' }>
): StickyPoint {
	if (point.blockId !== op.id) return point;
	const block = findBlock(page, op.id);
	if (!block) return point;
	try {
		const next = convertBlock(block, op);
		const newLen = isAtomic(next) ? 0 : payload(next).length;
		const text = isAtomic(next) ? '' : payload(next);
		return keep(point, point.blockId, snapOffset(text, Math.min(point.offset, newLen)));
	} catch {
		return point;
	}
}

function mapSetCode(
	page: KbPage,
	point: StickyPoint,
	op: Extract<Op, { kind: 'set-code' }>
): StickyPoint {
	if (point.blockId !== op.id) return point;
	const block = findBlock(page, op.id);
	if (!block || block.type !== 'code') return point;
	return keep(point, point.blockId, snapOffset(block.text, Math.min(point.offset, block.text.length)));
}

/**
 * Map both endpoints. `null` if either side was deleted (caller snaps).
 */
export function mapRangeThroughOp(pageBefore: KbPage, range: Range, op: Op): Range | null {
	const anchor = mapPointThroughOp(pageBefore, range.anchor, op);
	const head = mapPointThroughOp(pageBefore, range.head, op);
	if (!anchor || !head) return null;
	return { anchor, head };
}

/**
 * After mapPoint returns null: start of the following visible text-like in DFS,
 * else end of the previous, else the remaining empty paragraph. Never throws.
 */
export function snapMappedPoint(pageBefore: KbPage, pageAfter: KbPage, point: StickyPoint): StickyPoint {
	const visible = visibleOrder(pageBefore);
	const idx = visible.findIndex((block) => block.id === point.blockId);
	const stillThere = (id: string) => locateBlock(pageAfter, id);

	if (idx >= 0) {
		for (let i = idx + 1; i < visible.length; i++) {
			const candidate = visible[i];
			if (isTextLike(candidate) && stillThere(candidate.id)) {
				return keep(point, candidate.id, 0);
			}
		}
		for (let i = idx - 1; i >= 0; i--) {
			const candidate = visible[i];
			const live = stillThere(candidate.id);
			if (isTextLike(candidate) && live) {
				return keep(point, candidate.id, payload(live.block).length);
			}
		}
	}

	const remaining = visibleOrder(pageAfter);
	const fallback = remaining.find((block) => isTextLike(block)) ?? remaining[0];
	return keep(point, fallback.id, 0);
}
