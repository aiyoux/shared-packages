import {
	childrenOf,
	findBlock,
	isAtomic,
	isContainer,
	isHighSurrogate,
	isLowSurrogate,
	isTextLike,
	parentIdOf,
	parentOf,
	plaintextOf,
	type Block,
	type KbPage,
	type Op,
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

function isEmptyText(block: Block): boolean {
	return (isTextLike(block) || block.type === 'code') && plaintextOf(block).length === 0;
}

function liftOutOfContainer(page: KbPage, childId: string, container: Block): Op[] {
	const containerLoc = parentOf(page, container.id);
	if (!containerLoc) return [];
	const afterId =
		containerLoc.index === 0 ? null : childrenOf(page, containerLoc.parent)[containerLoc.index - 1].id;
	const parentId = parentIdOf(containerLoc.parent);
	return [{ kind: 'move-block', id: childId, afterId, parentId }];
}

function unwrapFirstChild(page: KbPage, current: Block, container: Block): Op[] {
	const kids = childrenOf(page, container);
	const onlyChild = kids.length === 1;
	if (isEmptyText(current)) {
		const ops = liftOutOfContainer(page, current.id, container);
		if (ops.length === 0) return [];
		if (onlyChild) ops.push({ kind: 'delete-block', id: container.id });
		return ops;
	}
	if (!onlyChild) return [];
	const containerLoc = parentOf(page, container.id);
	if (!containerLoc) return [];
	const parentId = parentIdOf(containerLoc.parent);
	if (containerLoc.index > 0) {
		const prev = childrenOf(page, containerLoc.parent)[containerLoc.index - 1];
		if (isTextLike(prev) || prev.type === 'code') {
			return [
				{ kind: 'move-block', id: current.id, afterId: prev.id, parentId },
				{ kind: 'merge-block', keepId: prev.id, dropId: current.id },
				{ kind: 'delete-block', id: container.id }
			];
		}
	}
	const ops = liftOutOfContainer(page, current.id, container);
	if (ops.length === 0) return [];
	ops.push({ kind: 'delete-block', id: container.id });
	return ops;
}

export function backspaceAtStartOps(page: KbPage, blockId: string): Op[] {
	const loc = parentOf(page, blockId);
	if (!loc) return [];
	if (loc.index <= 0) {
		if (loc.parent !== 'page' && isContainer(loc.parent)) {
			return unwrapFirstChild(page, childrenOf(page, loc.parent)[loc.index], loc.parent);
		}
		return [];
	}
	const siblings = childrenOf(page, loc.parent);
	const current = siblings[loc.index];
	const prev = siblings[loc.index - 1];
	if (current.type === 'table_cell' || prev.type === 'table_cell') return [];
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
	if (current.type === 'table_cell' || next.type === 'table_cell') return [];
	if (isAtomic(next)) return [{ kind: 'delete-block', id: next.id }];
	if (isTextLike(next) || next.type === 'code') {
		return [{ kind: 'merge-block', keepId: current.id, dropId: next.id }];
	}
	return [];
}
