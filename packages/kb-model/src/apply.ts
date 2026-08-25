import {
	canonicalMarks,
	emptyParagraph,
	emptySpans,
	normalizePage,
	normalizeSpans,
	orderedBlock,
	splitSpans
} from './normalize.js';
import {
	isAtomic,
	isContainer,
	isNonTextual,
	isTableStructure,
	isTextLike,
	plaintextOf
} from './plaintext.js';
import {
	blockChildren,
	childrenOf,
	documentOrder,
	isDescendant,
	lastDescendantId,
	locateBlock,
	parentOf,
	sameParent,
	subtreeContains,
	type ParentRef
} from './tree.js';
import type {
	Block,
	CodeBlock,
	KbPage,
	Mark,
	Op,
	Point,
	Range,
	TableBlock,
	TableCellBlock,
	TableRowBlock,
	TextSpan
} from './types.js';
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
	// Pretty JSON is the file. structuredClone throws DataCloneError on Svelte
	// $state proxies (the clone graph includes Window).
	return JSON.parse(JSON.stringify(page)) as KbPage;
}

function requireLocation(
	page: KbPage,
	id: string,
	what: string
): { block: Block; parent: ParentRef; index: number } {
	const loc = locateBlock(page, id);
	if (!loc) throw new Error(`${what}: unknown block ${id}`);
	return loc;
}

function documentIndex(page: KbPage, id: string): number {
	return documentOrder(page).findIndex((block) => block.id === id);
}

function blockText(block: Block): string {
	if (isTextLike(block) || block.type === 'code') return plaintextOf(block);
	return '';
}

export function resolvePoint(page: KbPage, point: Point): Resolved {
	const loc = locateBlock(page, point.blockId);
	if (!loc) {
		throw new UnresolvedPointError(`unresolved Point: unknown blockId ${point.blockId}`);
	}
	const { block } = loc;
	if (!Number.isInteger(point.offset)) {
		throw new UnresolvedPointError(`unresolved Point: offset ${point.offset} is not an integer`);
	}
	if (isNonTextual(block)) {
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
	if (isNonTextual(at.block)) {
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
	if (start.type === 'table_cell' || end.type === 'table_cell') return false;
	const startOk = isTextLike(start) || start.type === 'code';
	const endOk = isTextLike(end) || end.type === 'code';
	return startOk && endOk;
}

function clearCell(block: TableCellBlock): TableCellBlock {
	return block.header
		? { id: block.id, type: 'table_cell', header: true, content: emptySpans() }
		: { id: block.id, type: 'table_cell', content: emptySpans() };
}

function clearRow(block: TableRowBlock): TableRowBlock {
	return {
		id: block.id,
		type: 'table_row',
		children: block.children.map((cell) => clearCell(cell))
	};
}

function trimStartPrefix(block: Block, offset: number): Block | null {
	if (isNonTextual(block)) return null;
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
	if (isNonTextual(block)) return offset > 0 ? null : block;
	if (block.type === 'code') {
		return { ...block, text: block.text.slice(offset) };
	}
	if (isTextLike(block)) {
		const [, right] = splitSpans(block.content, offset);
		return { ...block, content: normalizeSpans(right) };
	}
	return null;
}

function dfsIndexMap(page: KbPage): Map<string, number> {
	const map = new Map<string, number>();
	const order = documentOrder(page);
	for (let i = 0; i < order.length; i++) map.set(order[i].id, i);
	return map;
}

function rewriteDeleteRange(
	list: Block[],
	start: Resolved,
	end: Resolved,
	idx: Map<string, number>
): Block[] {
	const startIdx = idx.get(start.block.id) ?? -1;
	const endIdx = idx.get(end.block.id) ?? -1;
	const next: Block[] = [];
	for (const block of list) {
		const i = idx.get(block.id) ?? -1;
		const j = idx.get(lastDescendantId(block)) ?? i;
		if (block.id === start.block.id) {
			if (block.type === 'table_cell') {
				const prefix = trimStartPrefix(block, start.offset);
				next.push(prefix ?? clearCell(block));
				continue;
			}
			if (block.type === 'table_row') {
				next.push(clearRow(block));
				continue;
			}
			const prefix = trimStartPrefix(block, start.offset);
			if (prefix) next.push(prefix);
			continue;
		}
		if (block.id === end.block.id) {
			if (block.type === 'table_cell') {
				const suffix = trimEndSuffix(block, end.offset);
				next.push(suffix ?? clearCell(block));
				continue;
			}
			if (block.type === 'table_row') {
				next.push(end.offset > 0 ? clearRow(block) : block);
				continue;
			}
			const suffix = trimEndSuffix(block, end.offset);
			if (suffix) next.push(suffix);
			continue;
		}
		if (i > startIdx && j < endIdx) {
			if (block.type === 'table_cell') {
				next.push(clearCell(block));
				continue;
			}
			if (block.type === 'table_row') {
				next.push(clearRow(block));
				continue;
			}
			continue;
		}
		const containsStart = i < startIdx && j >= startIdx;
		const containsEnd = i < endIdx && j >= endIdx;
		const kids = blockChildren(block);
		if ((containsStart || containsEnd) && kids) {
			const rewritten = rewriteDeleteRange(kids, start, end, idx);
			kids.splice(0, kids.length, ...rewritten);
			next.push(block);
			continue;
		}
		next.push(block);
	}
	return next;
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

	if (subtreeContains(start.block, end.block.id) && start.block.id !== end.block.id) {
		throw new Error('delete-range: cannot start on a container that contains the end');
	}

	const idx = dfsIndexMap(page);
	const rewritten = rewriteDeleteRange(page.blocks, start, end, idx);
	page.blocks.splice(0, page.blocks.length, ...rewritten);

	if (!sameParent(start.parent, end.parent)) return;

	const list = childrenOf(page, start.parent);
	const startI = list.findIndex((block) => block.id === start.block.id);
	const endI = list.findIndex((block) => block.id === end.block.id);
	if (startI < 0 || endI < 0 || endI !== startI + 1) return;
	const prefix = list[startI];
	const suffix = list[endI];
	if (!canConcat(start.block, end.block)) return;
	list.splice(startI, 2, concatEndOntoStart(prefix, suffix));
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

function subtreeIds(block: Block, into: string[] = []): string[] {
	into.push(block.id);
	const kids = blockChildren(block);
	if (kids) for (const child of kids) subtreeIds(child, into);
	return into;
}

function applySplitBlock(page: KbPage, op: Extract<Op, { kind: 'split-block' }>): void {
	if (locateBlock(page, op.newId)) {
		throw new Error(`split-block: newId ${op.newId} already exists`);
	}
	const at = resolvePoint(page, op.at);
	const block = at.block;
	if (isNonTextual(block) || block.type === 'table_cell') {
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
	if (isNonTextual(keep) || keep.type === 'table_cell') {
		throw new Error('cannot merge into atomic block');
	}
	if (isNonTextual(drop)) {
		deleteBlockAt(page, dropLoc.parent, dropLoc.index);
		return;
	}
	replaceBlock(page, keepLoc.parent, keepLoc.index, concatEndOntoStart(keep, drop));
	deleteBlockAt(page, dropLoc.parent, dropLoc.index);
}

const CONVERT_FORBIDDEN = new Set<Block['type']>([
	'image',
	'callout',
	'toggle',
	'table',
	'table_row',
	'table_cell'
]);

export function convertBlock(block: Block, op: Extract<Op, { kind: 'convert-block' }>): Block {
	if (CONVERT_FORBIDDEN.has(op.to)) {
		throw new Error(`cannot convert to ${op.to}`);
	}
	if (isContainer(block) || isTableStructure(block) || block.type === 'table_cell') {
		throw new Error(`cannot convert ${block.type}`);
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

function requireContainerParent(page: KbPage, parentId: string, what: string): Block {
	const loc = requireLocation(page, parentId, what);
	if (!isContainer(loc.block)) {
		throw new Error(`${what}: parentId must be a callout or toggle`);
	}
	if (loc.parent !== 'page') {
		throw new Error(`${what}: containers cannot be nested`);
	}
	return loc.block;
}

/** parentId omitted/null = page root. afterId must be a direct child of that parent. */
export function resolveInsertAnchor(
	page: KbPage,
	parentId: string | null | undefined,
	afterId: string | null,
	what: string
): { parent: ParentRef; index: number } {
	const parent: ParentRef = parentId == null ? 'page' : requireContainerParent(page, parentId, what);
	if (afterId === null) return { parent, index: 0 };
	const after = requireLocation(page, afterId, what);
	if (!sameParent(after.parent, parent)) {
		throw new Error(
			parent === 'page'
				? `${what}: afterId is not a child of the page`
				: `${what}: afterId is not a direct child of parentId`
		);
	}
	return { parent, index: after.index + 1 };
}

function assertInsertable(block: Block, depth: number): void {
	if (block.type === 'table_row' || block.type === 'table_cell') {
		throw new Error('insert-block: use table structural ops for cells/rows');
	}
	if (block.type === 'table') {
		if (depth >= 1) {
			throw new Error('insert-block: nested containers are not allowed');
		}
		for (const row of block.children) {
			if (row.type !== 'table_row') {
				throw new Error('insert-block: table children must be table_row');
			}
			for (const cell of row.children) {
				if (cell.type !== 'table_cell') {
					throw new Error('insert-block: table_row children must be table_cell');
				}
			}
		}
		return;
	}
	if (isContainer(block)) {
		if (depth >= 1) {
			throw new Error('insert-block: nested containers are not allowed');
		}
		for (const child of block.children) {
			if (isContainer(child) || child.type === 'table') {
				throw new Error('insert-block: nested containers are not allowed');
			}
		}
	}
}

function applyInsertBlock(page: KbPage, op: Extract<Op, { kind: 'insert-block' }>): void {
	const incoming = subtreeIds(op.block);
	const existing = new Set(documentOrder(page).map((block) => block.id));
	const seen = new Set<string>();
	for (const id of incoming) {
		if (seen.has(id) || existing.has(id)) {
			throw new Error(`insert-block: duplicate block id ${id}`);
		}
		seen.add(id);
	}
	const dest = resolveInsertAnchor(page, op.parentId, op.afterId, 'insert-block');
	assertInsertable(op.block, dest.parent === 'page' ? 0 : 1);
	if (isContainer(op.block) && op.afterId && subtreeContains(op.block, op.afterId)) {
		throw new Error('insert-block: cannot insert a container that already contains afterId');
	}
	insertBlockAt(page, dest.parent, dest.index, op.block);
}

function applyDeleteBlock(page: KbPage, id: string): void {
	const loc = requireLocation(page, id, 'delete-block');
	if (loc.block.type === 'table_row' || loc.block.type === 'table_cell') {
		throw new Error('delete-block: use table structural ops for cells/rows');
	}
	deleteBlockAt(page, loc.parent, loc.index);
}

function applyMoveBlock(page: KbPage, op: Extract<Op, { kind: 'move-block' }>): void {
	if (op.afterId === op.id) {
		throw new Error('cannot move block after itself');
	}
	const fromLoc = requireLocation(page, op.id, 'move-block');
	if (op.parentId === op.id) {
		throw new Error('move-block: cannot move a block into itself');
	}
	if (op.parentId != null && isDescendant(page, op.id, op.parentId)) {
		throw new Error('move-block: cannot move a block into its descendant');
	}
	if (op.afterId != null && isDescendant(page, op.id, op.afterId)) {
		throw new Error('move-block: cannot move a block into its descendant');
	}
	const dest = resolveInsertAnchor(page, op.parentId, op.afterId, 'move-block');
	if (fromLoc.block.type === 'table_row' || fromLoc.block.type === 'table_cell') {
		throw new Error('move-block: use table structural ops for cells/rows');
	}
	if (dest.parent !== 'page' && (isContainer(fromLoc.block) || fromLoc.block.type === 'table')) {
		throw new Error('move-block: nested containers are not allowed');
	}

	const fromList = childrenOf(page, fromLoc.parent);
	const [block] = fromList.splice(fromLoc.index, 1);
	const destList = childrenOf(page, dest.parent);
	let index: number;
	if (op.afterId === null) {
		index = 0;
	} else {
		const at = destList.findIndex((item) => item.id === op.afterId);
		if (at < 0) throw new Error(`move-block: unknown block ${op.afterId}`);
		index = at + 1;
	}
	destList.splice(index, 0, block);
}

function applySetCode(page: KbPage, op: Extract<Op, { kind: 'set-code' }>): void {
	const loc = requireLocation(page, op.id, 'set-code');
	const block = loc.block;
	if (block.type !== 'code') {
		throw new Error('set-code: block is not code');
	}
	replaceBlock(page, loc.parent, loc.index, { ...block, language: op.language });
}

function applySetToggle(page: KbPage, op: Extract<Op, { kind: 'set-toggle' }>): void {
	const loc = requireLocation(page, op.id, 'set-toggle');
	if (loc.block.type !== 'toggle') {
		throw new Error('set-toggle: block is not a toggle');
	}
	replaceBlock(page, loc.parent, loc.index, { ...loc.block, open: op.open });
}

function requireTable(page: KbPage, tableId: string, what: string): TableBlock {
	const loc = requireLocation(page, tableId, what);
	if (loc.block.type !== 'table') {
		throw new Error(`${what}: ${tableId} is not a table`);
	}
	if (loc.parent !== 'page') {
		throw new Error(`${what}: tables cannot be nested`);
	}
	return loc.block;
}

function tableWidth(table: TableBlock): number {
	return table.children[0]?.children.length ?? 0;
}

function applyInsertTableRow(page: KbPage, op: Extract<Op, { kind: 'insert-table-row' }>): void {
	const table = requireTable(page, op.tableId, 'insert-table-row');
	if (op.row.type !== 'table_row') {
		throw new Error('insert-table-row: row must be a table_row');
	}
	const width = tableWidth(table);
	if (width > 0 && op.row.children.length !== width) {
		throw new Error('insert-table-row: row must have one cell per column');
	}
	for (const cell of op.row.children) {
		if (cell.type !== 'table_cell') {
			throw new Error('insert-table-row: row children must be table_cell');
		}
	}
	const incoming = subtreeIds(op.row);
	const existing = new Set(documentOrder(page).map((block) => block.id));
	const seen = new Set<string>();
	for (const id of incoming) {
		if (seen.has(id) || existing.has(id)) {
			throw new Error(`insert-table-row: duplicate block id ${id}`);
		}
		seen.add(id);
	}
	let index = 0;
	if (op.afterId !== null) {
		const at = table.children.findIndex((row) => row.id === op.afterId);
		if (at < 0) throw new Error(`insert-table-row: afterId is not a row of ${op.tableId}`);
		index = at + 1;
	}
	table.children.splice(index, 0, orderedBlock(op.row) as TableRowBlock);
}

function applyInsertTableColumn(page: KbPage, op: Extract<Op, { kind: 'insert-table-column' }>): void {
	const table = requireTable(page, op.tableId, 'insert-table-column');
	const height = table.children.length;
	if (op.cells.length !== height) {
		throw new Error('insert-table-column: one cell per row');
	}
	if (!Number.isInteger(op.index) || op.index < 0 || op.index > tableWidth(table)) {
		throw new Error('insert-table-column: index out of range');
	}
	const existing = new Set(documentOrder(page).map((block) => block.id));
	const seen = new Set<string>();
	for (const cell of op.cells) {
		if (cell.type !== 'table_cell') {
			throw new Error('insert-table-column: cells must be table_cell');
		}
		if (seen.has(cell.id) || existing.has(cell.id)) {
			throw new Error(`insert-table-column: duplicate block id ${cell.id}`);
		}
		seen.add(cell.id);
	}
	for (let r = 0; r < height; r++) {
		table.children[r].children.splice(op.index, 0, orderedBlock(op.cells[r]) as TableCellBlock);
	}
}

function applyDeleteTableRow(page: KbPage, op: Extract<Op, { kind: 'delete-table-row' }>): void {
	const table = requireTable(page, op.tableId, 'delete-table-row');
	const index = table.children.findIndex((row) => row.id === op.rowId);
	if (index < 0) throw new Error(`delete-table-row: unknown row ${op.rowId}`);
	if (table.children.length <= 1) {
		throw new Error('delete-table-row: keep at least one row');
	}
	table.children.splice(index, 1);
}

function applyDeleteTableColumn(page: KbPage, op: Extract<Op, { kind: 'delete-table-column' }>): void {
	const table = requireTable(page, op.tableId, 'delete-table-column');
	const width = tableWidth(table);
	if (!Number.isInteger(op.index) || op.index < 0 || op.index >= width) {
		throw new Error('delete-table-column: index out of range');
	}
	if (width <= 1) {
		throw new Error('delete-table-column: keep at least one column');
	}
	for (const row of table.children) {
		row.children.splice(op.index, 1);
	}
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
		case 'set-toggle':
			applySetToggle(next, op);
			break;
		case 'insert-table-row':
			applyInsertTableRow(next, op);
			break;
		case 'insert-table-column':
			applyInsertTableColumn(next, op);
			break;
		case 'delete-table-row':
			applyDeleteTableRow(next, op);
			break;
		case 'delete-table-column':
			applyDeleteTableColumn(next, op);
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
