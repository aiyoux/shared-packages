import {
	canonicalMarks,
	emptyParagraph,
	emptySpans,
	normalizePage,
	normalizeSpans,
	orderedBlock,
	splitSpans
} from './normalize.js';
import { isAtomic, isTextLike, plaintextOf } from './plaintext.js';
import {
	childrenOf,
	documentOrder,
	findBlock,
	parentOf,
	sameParent,
	type ParentRef
} from './tree.js';
import type { Block, CodeBlock, KbPage, Mark, Op, Point, Range, TextSpan } from './types.js';
import { snapOffset } from './utf16.js';

export class UnresolvedPointError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnresolvedPointError';
	}
}

export type Resolved = {
	block: Block;
	parent: ParentRef;
	indexInParent: number;
	offset: number;
};

function clonePage(page: KbPage): KbPage {
	return structuredClone(page);
}

function requireLocation(
	page: KbPage,
	id: string,
	what: string
): { block: Block; parent: ParentRef; index: number } {
	const block = findBlock(page, id);
	const loc = parentOf(page, id);
	if (!block || !loc) throw new Error(`${what}: unknown block ${id}`);
	return { block, parent: loc.parent, index: loc.index };
}

function documentIndex(page: KbPage, id: string): number {
	return documentOrder(page).findIndex((block) => block.id === id);
}

function blockText(block: Block): string {
	if (isTextLike(block) || block.type === 'code') return plaintextOf(block);
	return '';
}

export function resolvePoint(page: KbPage, point: Point): Resolved {
	const block = findBlock(page, point.blockId);
	const loc = parentOf(page, point.blockId);
	if (!block || !loc) {
		throw new UnresolvedPointError(`unresolved Point: unknown blockId ${point.blockId}`);
	}
	if (!Number.isInteger(point.offset)) {
		throw new UnresolvedPointError(`unresolved Point: offset ${point.offset} is not an integer`);
	}
	if (isAtomic(block)) {
		if (point.offset !== 0) {
			throw new UnresolvedPointError(`unresolved Point: illegal offset ${point.offset} on atomic block`);
		}
		return { block, parent: loc.parent, indexInParent: loc.index, offset: 0 };
	}
	const text = blockText(block);
	if (point.offset < 0 || point.offset > text.length) {
		throw new UnresolvedPointError(
			`unresolved Point: offset ${point.offset} out of range for block ${point.blockId}`
		);
	}
	return {
		block,
		parent: loc.parent,
		indexInParent: loc.index,
		offset: snapOffset(text, point.offset)
	};
}

export function normalizeRange(
	page: KbPage,
	range: Range
): { start: Resolved; end: Resolved } {
	const anchor = resolvePoint(page, range.anchor);
	const head = resolvePoint(page, range.head);
	const ai = documentIndex(page, anchor.block.id);
	const hi = documentIndex(page, head.block.id);
	if (ai < hi || (ai === hi && anchor.offset <= head.offset)) {
		return { start: anchor, end: head };
	}
	return { start: head, end: anchor };
}

function ensureSpans(content: TextSpan[] | undefined): TextSpan[] {
	if (!content || content.length === 0) return emptySpans();
	return content;
}

function marksAtInsert(content: TextSpan[], offset: number): Mark[] {
	const spans = ensureSpans(content);
	const total = spans.reduce((sum, span) => sum + span.text.length, 0);
	const empty = total === 0 || (spans.length === 1 && spans[0].text === '');
	if (empty) return [];
	let pos = 0;
	for (let i = 0; i < spans.length; i++) {
		const next = pos + spans[i].text.length;
		if (offset === pos || offset === next) {
			if (offset > 0) {
				const leftIndex = offset === next ? i : i - 1;
				return canonicalMarks(spans[leftIndex].marks);
			}
			return canonicalMarks(spans[0].marks);
		}
		if (offset > pos && offset < next) {
			return canonicalMarks(spans[i].marks);
		}
		pos = next;
	}
	return canonicalMarks(spans[spans.length - 1].marks);
}

function insertIntoSpans(content: TextSpan[], offset: number, text: string): TextSpan[] {
	const spans = ensureSpans(content);
	const marks = marksAtInsert(spans, offset);
	const [left, right] = splitSpans(spans, offset);
	return normalizeSpans([...left, { type: 'text', text, marks }, ...right]);
}

function deleteFromSpans(content: TextSpan[], from: number, to: number): TextSpan[] {
	const [left, rest] = splitSpans(ensureSpans(content), from);
	const [, right] = splitSpans(rest, Math.max(0, to - from));
	return normalizeSpans([...left, ...right]);
}

function formatSpans(
	content: TextSpan[],
	from: number,
	to: number,
	mark: Mark,
	on: boolean
): TextSpan[] {
	const [left, rest] = splitSpans(ensureSpans(content), from);
	const [mid, right] = splitSpans(rest, Math.max(0, to - from));
	const formatted = mid.map((span) => {
		let marks = span.marks.filter((item) => item.type !== mark.type);
		if (on) marks = [...marks, mark];
		return { type: 'text' as const, text: span.text, marks };
	});
	return normalizeSpans([...left, ...formatted, ...right]);
}

function replaceBlock(page: KbPage, parent: ParentRef, index: number, block: Block): void {
	childrenOf(page, parent)[index] = orderedBlock(block);
}

function deleteBlockAt(page: KbPage, parent: ParentRef, index: number): void {
	childrenOf(page, parent).splice(index, 1);
}

function insertBlockAt(page: KbPage, parent: ParentRef, index: number, block: Block): void {
	childrenOf(page, parent).splice(index, 0, orderedBlock(block));
}

function applySetTitle(page: KbPage, title: string): void {
	page.title = title;
}

function applyInsertText(page: KbPage, op: Extract<Op, { kind: 'insert-text' }>): void {
	const at = resolvePoint(page, op.at);
	if (op.text === '') return;
	if (isAtomic(at.block)) {
		throw new Error('cannot insert text into atomic block');
	}
	if (isTextLike(at.block)) {
		if (op.text.includes('\n')) {
			throw new Error("newline not allowed in text-like block");
		}
		const next = { ...at.block, content: insertIntoSpans(at.block.content, at.offset, op.text) };
		replaceBlock(page, at.parent, at.indexInParent, next);
		return;
	}
	if (at.block.type === 'code') {
		const text = at.block.text.slice(0, at.offset) + op.text + at.block.text.slice(at.offset);
		replaceBlock(page, at.parent, at.indexInParent, { ...at.block, text });
		return;
	}
	throw new Error('cannot insert text into block');
}

function concatEndOntoStart(start: Block, end: Block): Block {
	if (isTextLike(start) && isTextLike(end)) {
		return { ...start, content: normalizeSpans([...start.content, ...end.content]) };
	}
	if (start.type === 'code' && (isTextLike(end) || end.type === 'code')) {
		const add = end.type === 'code' ? end.text : plaintextOf(end);
		return { ...start, text: start.text + add };
	}
	if (isTextLike(start) && end.type === 'code') {
		const text = end.text.replace(/\n/g, ' ');
		const extra: TextSpan[] = text ? [{ type: 'text', text, marks: [] }] : [];
		return { ...start, content: normalizeSpans([...start.content, ...extra]) };
	}
	return start;
}

function canConcat(start: Block, end: Block): boolean {
	const startOk = isTextLike(start) || start.type === 'code';
	const endOk = isTextLike(end) || end.type === 'code';
	return startOk && endOk;
}

function trimStartPrefix(block: Block, offset: number): Block | null {
	if (isAtomic(block)) return null;
	if (block.type === 'code') {
		return { ...block, text: block.text.slice(0, offset) };
	}
	if (isTextLike(block)) {
		const [left] = splitSpans(block.content, offset);
		return { ...block, content: normalizeSpans(left) };
	}
	return null;
}

function trimEndSuffix(block: Block, offset: number): Block | null {
	if (isAtomic(block)) return offset > 0 ? null : block;
	if (block.type === 'code') {
		return { ...block, text: block.text.slice(offset) };
	}
	if (isTextLike(block)) {
		const [, right] = splitSpans(block.content, offset);
		return { ...block, content: normalizeSpans(right) };
	}
	return null;
}

function applyDeleteRange(page: KbPage, op: Extract<Op, { kind: 'delete-range' }>): void {
	const { start, end } = normalizeRange(page, op.range);
	if (start.block.id === end.block.id && start.offset === end.offset) return;

	if (start.block.id === end.block.id) {
		const block = start.block;
		if (block.type === 'code') {
			const text = block.text.slice(0, start.offset) + block.text.slice(end.offset);
			replaceBlock(page, start.parent, start.indexInParent, { ...block, text });
			return;
		}
		if (isTextLike(block)) {
			replaceBlock(page, start.parent, start.indexInParent, {
				...block,
				content: deleteFromSpans(block.content, start.offset, end.offset)
			});
		}
		return;
	}

	if (!sameParent(start.parent, end.parent)) {
		throw new Error('delete-range: start and end must share a parent');
	}

	const list = childrenOf(page, start.parent);
	const startBlock = list[start.indexInParent];
	const endBlock = list[end.indexInParent];
	const prefix = trimStartPrefix(startBlock, start.offset);
	const suffix = trimEndSuffix(endBlock, end.offset);
	const before = list.slice(0, start.indexInParent);
	const after = list.slice(end.indexInParent + 1);
	const next: Block[] = [...before];

	if (prefix && suffix && canConcat(startBlock, endBlock)) {
		next.push(concatEndOntoStart(prefix, suffix));
	} else {
		if (prefix) next.push(prefix);
		if (suffix) next.push(suffix);
	}
	next.push(...after);
	list.splice(0, list.length, ...next);
}

function applyFormatRange(page: KbPage, op: Extract<Op, { kind: 'format-range' }>): void {
	const { start, end } = normalizeRange(page, op.range);
	if (start.block.id === end.block.id && start.offset === end.offset) return;
	const order = documentOrder(page);
	const si = order.findIndex((block) => block.id === start.block.id);
	const ei = order.findIndex((block) => block.id === end.block.id);
	for (let i = si; i <= ei; i++) {
		const block = order[i];
		if (!isTextLike(block)) continue;
		const from = i === si ? start.offset : 0;
		const to = i === ei ? end.offset : plaintextOf(block).length;
		if (from === to) continue;
		const loc = parentOf(page, block.id);
		if (!loc) continue;
		replaceBlock(page, loc.parent, loc.index, {
			...block,
			content: formatSpans(block.content, from, to, op.mark, op.on)
		});
	}
}

function isCodeEmptyLastLine(block: CodeBlock, offset: number): boolean {
	return offset === block.text.length && (block.text === '' || block.text.endsWith('\n'));
}

function applySplitBlock(page: KbPage, op: Extract<Op, { kind: 'split-block' }>): void {
	if (findBlock(page, op.newId)) {
		throw new Error(`split-block: newId ${op.newId} already exists`);
	}
	const at = resolvePoint(page, op.at);
	const block = at.block;
	if (isAtomic(block)) {
		throw new Error('cannot split atomic block');
	}
	if (block.type === 'code') {
		if (!isCodeEmptyLastLine(block, at.offset)) {
			throw new Error('cannot split code except at empty last line');
		}
		const text = block.text.endsWith('\n') ? block.text.slice(0, -1) : block.text;
		replaceBlock(page, at.parent, at.indexInParent, { ...block, text });
		insertBlockAt(page, at.parent, at.indexInParent + 1, emptyParagraph(op.newId));
		return;
	}
	if (isTextLike(block)) {
		const [left, right] = splitSpans(block.content, at.offset);
		const keepContent = normalizeSpans(left);
		const dropContent = normalizeSpans(right);
		replaceBlock(page, at.parent, at.indexInParent, { ...block, content: keepContent });
		let created: Block;
		if (block.type === 'heading') {
			created = { id: op.newId, type: 'heading', level: block.level, content: dropContent };
		} else if (block.type === 'list_item') {
			created = { id: op.newId, type: 'list_item', ordered: block.ordered, content: dropContent };
		} else {
			created = { id: op.newId, type: 'paragraph', content: dropContent };
		}
		insertBlockAt(page, at.parent, at.indexInParent + 1, created);
	}
}

function applyMergeBlock(page: KbPage, op: Extract<Op, { kind: 'merge-block' }>): void {
	if (op.keepId === op.dropId) {
		throw new Error('merge-block: keepId and dropId must differ');
	}
	const keepLoc = requireLocation(page, op.keepId, 'merge-block');
	const dropLoc = requireLocation(page, op.dropId, 'merge-block');
	if (!sameParent(keepLoc.parent, dropLoc.parent) || dropLoc.index !== keepLoc.index + 1) {
		throw new Error('merge-block: dropId must be the immediate next sibling of keepId');
	}
	const keep = keepLoc.block;
	const drop = dropLoc.block;
	if (isAtomic(keep)) {
		throw new Error('cannot merge into atomic block');
	}
	if (isAtomic(drop)) {
		deleteBlockAt(page, dropLoc.parent, dropLoc.index);
		return;
	}
	replaceBlock(page, keepLoc.parent, keepLoc.index, concatEndOntoStart(keep, drop));
	deleteBlockAt(page, dropLoc.parent, dropLoc.index);
}

export function convertBlock(block: Block, op: Extract<Op, { kind: 'convert-block' }>): Block {
	if (op.to === 'image') {
		throw new Error('cannot convert to image');
	}
	if (block.type === op.to) {
		if (block.type === 'heading') {
			return { ...block, level: op.level ?? block.level };
		}
		if (block.type === 'list_item') {
			return { ...block, ordered: op.ordered ?? block.ordered };
		}
		return block;
	}

	const id = block.id;
	const content = isTextLike(block) ? block.content : emptySpans();
	const level = op.level ?? 1;
	const ordered = op.ordered ?? false;

	if (isTextLike(block)) {
		if (op.to === 'paragraph') return { id, type: 'paragraph', content };
		if (op.to === 'heading') return { id, type: 'heading', level, content };
		if (op.to === 'list_item') return { id, type: 'list_item', ordered, content };
		if (op.to === 'code') return { id, type: 'code', language: '', text: plaintextOf(block) };
		if (op.to === 'divider') return { id, type: 'divider' };
	}

	if (block.type === 'code') {
		const text = block.text.replace(/\n/g, ' ');
		const spans: TextSpan[] = text ? [{ type: 'text', text, marks: [] }] : emptySpans();
		if (op.to === 'paragraph') return { id, type: 'paragraph', content: spans };
		if (op.to === 'heading') return { id, type: 'heading', level, content: spans };
		if (op.to === 'list_item') return { id, type: 'list_item', ordered, content: spans };
		if (op.to === 'divider') return { id, type: 'divider' };
	}

	if (isAtomic(block)) {
		if (op.to === 'paragraph') return { id, type: 'paragraph', content: emptySpans() };
		if (op.to === 'heading') return { id, type: 'heading', level, content: emptySpans() };
		if (op.to === 'list_item') return { id, type: 'list_item', ordered, content: emptySpans() };
		if (op.to === 'code') return { id, type: 'code', language: '', text: '' };
		if (op.to === 'divider') return { id, type: 'divider' };
	}

	throw new Error(`cannot convert ${block.type} to ${op.to}`);
}

function applyConvertBlock(page: KbPage, op: Extract<Op, { kind: 'convert-block' }>): void {
	const loc = requireLocation(page, op.id, 'convert-block');
	replaceBlock(page, loc.parent, loc.index, convertBlock(loc.block, op));
}

function applyInsertBlock(page: KbPage, op: Extract<Op, { kind: 'insert-block' }>): void {
	if (findBlock(page, op.block.id)) {
		throw new Error(`insert-block: duplicate block id ${op.block.id}`);
	}
	if (op.afterId === null) {
		insertBlockAt(page, 'page', 0, op.block);
		return;
	}
	const after = requireLocation(page, op.afterId, 'insert-block');
	insertBlockAt(page, after.parent, after.index + 1, op.block);
}

function applyDeleteBlock(page: KbPage, id: string): void {
	const loc = requireLocation(page, id, 'delete-block');
	deleteBlockAt(page, loc.parent, loc.index);
}

function applyMoveBlock(page: KbPage, op: Extract<Op, { kind: 'move-block' }>): void {
	if (op.afterId === op.id) {
		throw new Error('cannot move block after itself');
	}
	const fromLoc = requireLocation(page, op.id, 'move-block');
	if (op.afterId !== null) requireLocation(page, op.afterId, 'move-block');
	const fromList = childrenOf(page, fromLoc.parent);
	const [block] = fromList.splice(fromLoc.index, 1);
	if (op.afterId === null) {
		childrenOf(page, 'page').unshift(block);
		return;
	}
	const toLoc = parentOf(page, op.afterId);
	if (!toLoc) throw new Error(`move-block: unknown block ${op.afterId}`);
	const toList = childrenOf(page, toLoc.parent);
	const to = toList.findIndex((item) => item.id === op.afterId);
	if (to < 0) throw new Error(`move-block: unknown block ${op.afterId}`);
	toList.splice(to + 1, 0, block);
}

function applySetCode(page: KbPage, op: Extract<Op, { kind: 'set-code' }>): void {
	const loc = requireLocation(page, op.id, 'set-code');
	const block = loc.block;
	if (block.type !== 'code') {
		throw new Error('set-code: block is not code');
	}
	replaceBlock(page, loc.parent, loc.index, { ...block, language: op.language });
}

function applySetChildren(page: KbPage, children: string[]): void {
	page.children = [...children];
}

export function apply(page: KbPage, op: Op): KbPage {
	const next = clonePage(page);
	switch (op.kind) {
		case 'set-title':
			applySetTitle(next, op.title);
			break;
		case 'insert-text':
			applyInsertText(next, op);
			break;
		case 'delete-range':
			applyDeleteRange(next, op);
			break;
		case 'format-range':
			applyFormatRange(next, op);
			break;
		case 'split-block':
			applySplitBlock(next, op);
			break;
		case 'merge-block':
			applyMergeBlock(next, op);
			break;
		case 'insert-block':
			applyInsertBlock(next, op);
			break;
		case 'delete-block':
			applyDeleteBlock(next, op.id);
			break;
		case 'move-block':
			applyMoveBlock(next, op);
			break;
		case 'convert-block':
			applyConvertBlock(next, op);
			break;
		case 'set-code':
			applySetCode(next, op);
			break;
		case 'set-children':
			applySetChildren(next, op.children);
			break;
		default: {
			const _never: never = op;
			throw new Error(`unknown op: ${(_never as Op).kind}`);
		}
	}
	return normalizePage(next);
}

export function applyMany(page: KbPage, ops: Op[]): KbPage {
	let current = page;
	for (const op of ops) current = apply(current, op);
	return current;
}
