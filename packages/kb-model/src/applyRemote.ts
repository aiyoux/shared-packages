import { apply } from './apply.js';
import { mapPointThroughOp, type StickyPoint } from './mapPoint.js';
import { isAtomic, isTextLike, plaintextOf } from './plaintext.js';
import { locateBlock } from './tree.js';
import type { Block, KbPage, Op, Point } from './types.js';
import { snapOffset } from './utf16.js';

function payload(block: Block): string {
	if (isTextLike(block) || block.type === 'code') return plaintextOf(block);
	return '';
}

/** Clamp an illegal Point onto the live block. `null` if the block is gone. */
export function clampPoint(page: KbPage, point: Point): Point | null {
	const loc = locateBlock(page, point.blockId);
	if (!loc) return null;
	if (isAtomic(loc.block)) return { blockId: point.blockId, offset: 0 };
	const text = payload(loc.block);
	const raw = Number.isFinite(point.offset) ? Math.trunc(point.offset) : 0;
	return { blockId: point.blockId, offset: snapOffset(text, Math.max(0, Math.min(text.length, raw))) };
}

function clampOp(page: KbPage, op: Op): Op | null {
	switch (op.kind) {
		case 'insert-text': {
			const at = clampPoint(page, op.at);
			return at ? { ...op, at } : null;
		}
		case 'delete-range':
		case 'format-range': {
			const anchor = clampPoint(page, op.range.anchor);
			const head = clampPoint(page, op.range.head);
			if (!anchor || !head) return null;
			return { ...op, range: { ...op.range, anchor, head } };
		}
		case 'split-block': {
			const at = clampPoint(page, op.at);
			return at ? { ...op, at } : null;
		}
		default:
			return op;
	}
}

/**
 * Remote-safe apply: clamp illegal points and drop ops that still cannot apply.
 * Local dispatch keeps `apply()`, which throws `UnresolvedPointError`.
 */
export function applyRemote(page: KbPage, op: Op): KbPage {
	const clamped = clampOp(page, op);
	if (!clamped) return page;
	try {
		return apply(page, clamped);
	} catch {
		return page;
	}
}

export function applyRemoteMany(page: KbPage, ops: Op[]): KbPage {
	let current = page;
	for (const op of ops) current = applyRemote(current, op);
	return current;
}

/**
 * Batch: clamp each op the way applyRemote will, map against the page *before
 * that op*, then apply. If applyRemote drops the op, keep the pre-map point.
 */
export function applyRemoteBatch(
	page: KbPage,
	ops: Op[],
	point: StickyPoint
): { page: KbPage; point: StickyPoint | null } {
	let current = page;
	let mapped: StickyPoint | null = point;
	for (const op of ops) {
		const clamped = clampOp(current, op);
		if (!clamped) continue;
		const nextMapped: StickyPoint | null = mapped && mapPointThroughOp(current, mapped, clamped);
		const next = applyRemote(current, clamped);
		if (next === current) continue;
		mapped = nextMapped;
		current = next;
	}
	return { page: current, point: mapped };
}
