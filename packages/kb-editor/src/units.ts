import {
	childrenOf,
	findBlock,
	isAtomic,
	isHighSurrogate,
	isLowSurrogate,
	isTextLike,
	parentOf,
	plaintextOf,
	type Block,
	type KbPage,
	type Range
} from '@shared-packages/kb-model';
import { isCollapsed } from './range.js';

function unitBefore(text: string, offset: number): number {
	if (offset <= 0) return 0;
	let from = offset - 1;
	if (from > 0 && isLowSurrogate(text.charCodeAt(from)) && isHighSurrogate(text.charCodeAt(from - 1))) {
		from -= 1;
	}
	return from;
}

function unitAfter(text: string, offset: number): number {
	if (offset >= text.length) return text.length;
	let to = offset + 1;
	if (
		to < text.length &&
		isHighSurrogate(text.charCodeAt(offset)) &&
		isLowSurrogate(text.charCodeAt(to))
	) {
		to += 1;
	}
	return to;
}

export function isCodeEmptyLastLine(block: Extract<Block, { type: 'code' }>, offset: number): boolean {
	return offset === block.text.length && (block.text === '' || block.text.endsWith('\n'));
}

export function expandCaretToUnit(
	page: KbPage,
	selection: Range,
	direction: 'backward' | 'forward'
): Range | null {
	if (!isCollapsed(selection)) return selection;
	const point = selection.anchor;
	const block = findBlock(page, point.blockId);
	if (!block) return null;
	if (isAtomic(block)) {
		return { anchor: { blockId: block.id, offset: 0 }, head: { blockId: block.id, offset: 0 } };
	}
	const text = plaintextOf(block);
	if (direction === 'backward') {
		if (point.offset === 0) return null;
		const from = unitBefore(text, point.offset);
		return { anchor: { blockId: point.blockId, offset: from }, head: point };
	}
	if (point.offset >= text.length) return null;
	const to = unitAfter(text, point.offset);
	return { anchor: point, head: { blockId: point.blockId, offset: to } };
}

export function backspaceAtStartOps(page: KbPage, blockId: string): import('@shared-packages/kb-model').Op[] {
	const loc = parentOf(page, blockId);
	if (!loc || loc.index <= 0) return [];
	const siblings = childrenOf(page, loc.parent);
	const current = siblings[loc.index];
	const prev = siblings[loc.index - 1];
	if (current.type === 'list_item' && plaintextOf(current) === '' && prev.type !== 'list_item') {
		return [{ kind: 'convert-block', id: current.id, to: 'paragraph' }];
	}
	if (isTextLike(prev) || prev.type === 'code') {
		return [{ kind: 'merge-block', keepId: prev.id, dropId: current.id }];
	}
	if (isAtomic(prev)) {
		return [{ kind: 'delete-block', id: prev.id }];
	}
	return [];
}

export function deleteAtEndOps(page: KbPage, blockId: string): import('@shared-packages/kb-model').Op[] {
	const loc = parentOf(page, blockId);
	if (!loc) return [];
	const siblings = childrenOf(page, loc.parent);
	if (loc.index >= siblings.length - 1) return [];
	const current = siblings[loc.index];
	const next = siblings[loc.index + 1];
	if (isAtomic(next)) return [{ kind: 'delete-block', id: next.id }];
	if (isTextLike(next) || next.type === 'code') {
		return [{ kind: 'merge-block', keepId: current.id, dropId: next.id }];
	}
	return [];
}
