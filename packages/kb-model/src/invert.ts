import { convertBlock, normalizeRange, resolvePoint } from './apply.js';
import { sliceSpans } from './normalize.js';
import { isNonTextual, isTextLike, payloadLength, plaintextOf } from './plaintext.js';
import {
	childrenOf,
	documentOrder,
	lastDescendantId,
	locateBlock,
	parentOf,
	parentIdOf,
	sameParent,
	type ParentRef
} from './tree.js';
import type { Block, KbPage, Mark, Op, Point, TableCellBlock, TableRowBlock, TextSpan } from './types.js';

function cloneBlock(block: Block): Block {
	return structuredClone(block);
}

function prevSiblingId(page: KbPage, id: string): string | null {
	const loc = parentOf(page, id);
	if (!loc || loc.index <= 0) return null;
	return childrenOf(page, loc.parent)[loc.index - 1].id;
}

function requireBlock(
	page: KbPage,
	id: string,
	what: string
): { block: Block; parent: ParentRef; index: number } {
	const loc = locateBlock(page, id);
	if (!loc) throw new Error(`${what}: unknown block ${id}`);
	return loc;
}

function insertBlockOp(page: KbPage, block: Block): Extract<Op, { kind: 'insert-block' }> {
	const loc = requireBlock(page, block.id, 'insert-block');
	return {
		kind: 'insert-block',
		afterId: prevSiblingId(page, block.id),
		parentId: parentIdOf(loc.parent),
		block: cloneBlock(block)
	};
}

const STRIP_MARKS: Mark[] = [
	{ type: 'bold' },
	{ type: 'italic' },
	{ type: 'code' },
	{ type: 'link', href: '' }
];

function restoreInsertedSpans(blockId: string, offset: number, spans: TextSpan[]): Op[] {
	const text = spans.map((span) => span.text).join('');
	if (!text) return [];
	const ops: Op[] = [{ kind: 'insert-text', at: { blockId, offset }, text }];
	const whole = {
		anchor: { blockId, offset },
		head: { blockId, offset: offset + text.length }
	};
	for (const mark of STRIP_MARKS) {
		ops.push({ kind: 'format-range', range: whole, mark, on: false });
	}
	let pos = offset;
	for (const span of spans) {
		const end = pos + span.text.length;
		for (const mark of span.marks) {
			ops.push({
				kind: 'format-range',
				range: { anchor: { blockId, offset: pos }, head: { blockId, offset: end } },
				mark,
				on: true
			});
		}
		pos = end;
	}
	return ops;
}

function insertSlice(block: Block, from: number, to: number, atOffset: number): Op[] {
	if (from >= to) return [];
	if (block.type === 'code') {
		const text = block.text.slice(from, to);
		if (!text) return [];
		return [{ kind: 'insert-text', at: { blockId: block.id, offset: atOffset }, text }];
	}
	if (isTextLike(block)) {
		return restoreInsertedSpans(block.id, atOffset, sliceSpans(block.content, from, to));
	}
	return [];
}

function convertedSuffixLength(start: Block, end: Block, endOffset: number): number {
	const endLen = payloadLength(end);
	if (endOffset >= endLen) return 0;
	if (end.type === 'code') {
		const suffix = end.text.slice(endOffset);
		if (isTextLike(start)) return suffix.replace(/\n/g, ' ').length;
		return suffix.length;
	}
	if (isTextLike(end)) {
		return plaintextOf(end).slice(endOffset).length;
	}
	return 0;
}

function canConcat(start: Block, end: Block): boolean {
	if (start.type === 'table_cell' || end.type === 'table_cell') return false;
	const startOk = isTextLike(start) || start.type === 'code';
	const endOk = isTextLike(end) || end.type === 'code';
	return startOk && endOk;
}

function trimStartPrefixExists(block: Block, offset: number): boolean {
	if (isNonTextual(block)) return false;
	return isTextLike(block) || block.type === 'code';
}

function fullyCoveredRoots(page: KbPage, startId: string, endId: string): Block[] {
	const order = documentOrder(page);
	const idx = new Map<string, number>();
	for (let i = 0; i < order.length; i++) idx.set(order[i].id, i);
	const startIdx = idx.get(startId) ?? -1;
	const endIdx = idx.get(endId) ?? -1;
	const roots: Block[] = [];
	const covered = new Set<string>();

	function ancestorCovered(block: Block): boolean {
		let loc = parentOf(page, block.id);
		while (loc && loc.parent !== 'page') {
			if (covered.has(loc.parent.id)) return true;
			loc = parentOf(page, loc.parent.id);
		}
		return false;
	}

	for (const block of order) {
		if (block.id === startId || block.id === endId) {
			// Mark the endpoint so descendants of a dropped start container are not
			// re-inserted beside the cloned subtree.
			covered.add(block.id);
			continue;
		}
		const i = idx.get(block.id) ?? -1;
		const j = idx.get(lastDescendantId(block)) ?? i;
		if (!(i > startIdx && j < endIdx)) continue;
		if (ancestorCovered(block)) continue;
		roots.push(block);
		covered.add(block.id);
	}
	return roots;
}

function restoreClearedTableContent(block: Block): Op[] {
	if (block.type === 'table_cell') {
		return restoreInsertedSpans(block.id, 0, block.content);
	}
	if (block.type === 'table_row') {
		const ops: Op[] = [];
		for (const cell of block.children) {
			ops.push(...restoreInsertedSpans(cell.id, 0, cell.content));
		}
		return ops;
	}
	return [];
}

function invertDeleteRange(page: KbPage, op: Extract<Op, { kind: 'delete-range' }>): Op[] {
	const { start, end } = normalizeRange(page, op.range);
	if (start.block.id === end.block.id && start.offset === end.offset) return [];

	if (start.block.id === end.block.id) {
		if (isNonTextual(start.block)) {
			return [insertBlockOp(page, start.block)];
		}
		return insertSlice(start.block, start.offset, end.offset, start.offset);
	}

	const startBlock = start.block;
	const endBlock = end.block;
	const roots = fullyCoveredRoots(page, startBlock.id, endBlock.id);
	const same = sameParent(start.parent, end.parent);
	const startRowKept = startBlock.type === 'table_row';
	const startSurvives = trimStartPrefixExists(startBlock, start.offset) || startRowKept;
	const willConcat = same && startSurvives && canConcat(startBlock, endBlock) && !isNonTextual(endBlock);
	const cleared = roots.filter((block) => block.type === 'table_cell' || block.type === 'table_row');
	const insertRoots = roots.filter((block) => block.type !== 'table_cell' && block.type !== 'table_row');

	const ops: Op[] = [];

	function restoreStart(): void {
		if (startRowKept) {
			ops.push(...restoreClearedTableContent(startBlock));
			return;
		}
		if (startSurvives) {
			ops.push(...insertSlice(startBlock, start.offset, payloadLength(startBlock), start.offset));
		}
	}

	function insertable(block: Block): boolean {
		return block.type !== 'table_cell' && block.type !== 'table_row';
	}

	if (willConcat) {
		const suffixLen = convertedSuffixLength(startBlock, endBlock, end.offset);
		if (suffixLen > 0) {
			ops.push({
				kind: 'delete-range',
				range: {
					anchor: { blockId: startBlock.id, offset: start.offset },
					head: { blockId: startBlock.id, offset: start.offset + suffixLen }
				}
			});
		}
		restoreStart();
		for (const block of cleared) ops.push(...restoreClearedTableContent(block));
		for (const block of [...insertRoots, endBlock].filter(insertable)) {
			ops.push(insertBlockOp(page, block));
		}
		return ops;
	}

	restoreStart();
	for (const block of cleared) ops.push(...restoreClearedTableContent(block));
	const toInsert = (startSurvives ? insertRoots : [startBlock, ...insertRoots]).filter(insertable);
	for (const block of toInsert) {
		ops.push(insertBlockOp(page, block));
	}
	if (!isNonTextual(endBlock) && end.offset > 0) {
		ops.push(...insertSlice(endBlock, 0, end.offset, 0));
	}
	return ops;
}

function findLinkHref(page: KbPage, range: Extract<Op, { kind: 'format-range' }>['range']): string | null {
	const { start, end } = normalizeRange(page, range);
	const order = documentOrder(page);
	const si = order.findIndex((block) => block.id === start.block.id);
	const ei = order.findIndex((block) => block.id === end.block.id);
	for (let i = si; i <= ei; i++) {
		const block = order[i];
		if (!isTextLike(block)) continue;
		const from = i === si ? start.offset : 0;
		const to = i === ei ? end.offset : plaintextOf(block).length;
		for (const span of sliceSpans(block.content, from, to)) {
			const link = span.marks.find((mark): mark is Extract<Mark, { type: 'link' }> => mark.type === 'link');
			if (link) return link.href;
		}
	}
	return null;
}

function invertFormatRange(page: KbPage, op: Extract<Op, { kind: 'format-range' }>): Op[] {
	const { start, end } = normalizeRange(page, op.range);
	if (start.block.id === end.block.id && start.offset === end.offset) return [];
	let mark = op.mark;
	if (mark.type === 'link' && !op.on) {
		const href = findLinkHref(page, op.range);
		if (href != null) mark = { type: 'link', href };
	}
	return [{ kind: 'format-range', range: op.range, mark, on: !op.on }];
}

function invertSplitBlock(page: KbPage, op: Extract<Op, { kind: 'split-block' }>): Op[] {
	const at = resolvePoint(page, op.at);
	const ops: Op[] = [{ kind: 'merge-block', keepId: at.block.id, dropId: op.newId }];
	if (at.block.type === 'code' && at.block.text.endsWith('\n')) {
		ops.push({
			kind: 'insert-text',
			at: { blockId: at.block.id, offset: at.block.text.length - 1 },
			text: '\n'
		});
	}
	return ops;
}

function sameTextLikeShape(keep: Block, drop: Block): boolean {
	if (!isTextLike(keep) || !isTextLike(drop)) return false;
	if (keep.type !== drop.type) return false;
	if (keep.type === 'heading' && drop.type === 'heading') return keep.level === drop.level;
	if (keep.type === 'list_item' && drop.type === 'list_item') return keep.ordered === drop.ordered;
	return true;
}

function convertDropBack(drop: Block): Op[] {
	const op: Extract<Op, { kind: 'convert-block' }> = {
		kind: 'convert-block',
		id: drop.id,
		to: drop.type
	};
	if (drop.type === 'heading') op.level = drop.level;
	if (drop.type === 'list_item') op.ordered = drop.ordered;
	const ops: Op[] = [op];
	if (drop.type === 'code') {
		const coerced = drop.text.replace(/\n/g, ' ');
		if (coerced.length > 0) {
			ops.push({
				kind: 'delete-range',
				range: {
					anchor: { blockId: drop.id, offset: 0 },
					head: { blockId: drop.id, offset: coerced.length }
				}
			});
		}
		if (drop.text) {
			ops.push({ kind: 'insert-text', at: { blockId: drop.id, offset: 0 }, text: drop.text });
		}
		ops.push({ kind: 'set-code', id: drop.id, language: drop.language });
	}
	return ops;
}

function invertMergeBlock(page: KbPage, op: Extract<Op, { kind: 'merge-block' }>): Op[] {
	if (op.keepId === op.dropId) {
		throw new Error('merge-block: keepId and dropId must differ');
	}
	const keep = requireBlock(page, op.keepId, 'merge-block');
	const drop = requireBlock(page, op.dropId, 'merge-block');
	if (!sameParent(keep.parent, drop.parent) || drop.index !== keep.index + 1) {
		throw new Error('merge-block: dropId must be the immediate next sibling of keepId');
	}
	if (isNonTextual(keep.block) || keep.block.type === 'table_cell') {
		throw new Error('cannot merge into atomic block');
	}
	const dropSnap = cloneBlock(drop.block);
	if (isNonTextual(drop.block)) {
		return [
			{
				kind: 'insert-block',
				afterId: op.keepId,
				parentId: parentIdOf(keep.parent),
				block: dropSnap
			}
		];
	}

	const keepLen = payloadLength(keep.block);

	if (keep.block.type === 'code') {
		const added = drop.block.type === 'code' ? drop.block.text : plaintextOf(drop.block);
		const ops: Op[] = [];
		if (added.length > 0) {
			ops.push({
				kind: 'delete-range',
				range: {
					anchor: { blockId: op.keepId, offset: keepLen },
					head: { blockId: op.keepId, offset: keepLen + added.length }
				}
			});
		}
		ops.push({
			kind: 'insert-block',
			afterId: op.keepId,
			parentId: parentIdOf(keep.parent),
			block: dropSnap
		});
		return ops;
	}

	if (sameTextLikeShape(keep.block, drop.block)) {
		return [{ kind: 'split-block', at: { blockId: op.keepId, offset: keepLen }, newId: op.dropId }];
	}

	return [
		{ kind: 'split-block', at: { blockId: op.keepId, offset: keepLen }, newId: op.dropId },
		...convertDropBack(drop.block)
	];
}

function isLosslessTextLikeConvert(from: Block, to: Block['type']): boolean {
	const textLike = from.type === 'paragraph' || from.type === 'heading' || from.type === 'list_item';
	const toTextLike = to === 'paragraph' || to === 'heading' || to === 'list_item';
	return textLike && toTextLike;
}

function isNoOpConvert(block: Block, op: Extract<Op, { kind: 'convert-block' }>): boolean {
	if (block.type !== op.to) return false;
	if (block.type === 'heading') return (op.level ?? block.level) === block.level;
	if (block.type === 'list_item') return (op.ordered ?? block.ordered) === block.ordered;
	return true;
}

function restoreSolePayload(id: string, snap: Block, coercedLen: number): Op[] {
	const ops: Op[] = [];
	if (coercedLen > 0) {
		ops.push({
			kind: 'delete-range',
			range: {
				anchor: { blockId: id, offset: 0 },
				head: { blockId: id, offset: coercedLen }
			}
		});
	}
	if (snap.type === 'code') {
		if (snap.text) {
			ops.push({ kind: 'insert-text', at: { blockId: id, offset: 0 }, text: snap.text });
		}
		ops.push({ kind: 'set-code', id, language: snap.language });
		return ops;
	}
	if (isTextLike(snap)) {
		ops.push(...restoreInsertedSpans(id, 0, snap.content));
	}
	return ops;
}

function invertConvertBlock(page: KbPage, op: Extract<Op, { kind: 'convert-block' }>): Op[] {
	const { block, parent } = requireBlock(page, op.id, 'convert-block');
	if (
		op.to === 'image' ||
		op.to === 'callout' ||
		op.to === 'toggle' ||
		op.to === 'table' ||
		op.to === 'table_row' ||
		op.to === 'table_cell'
	) {
		throw new Error(`cannot convert to ${op.to}`);
	}
	if (isNoOpConvert(block, op)) return [];
	if (isLosslessTextLikeConvert(block, op.to)) {
		const inverse: Extract<Op, { kind: 'convert-block' }> = {
			kind: 'convert-block',
			id: op.id,
			to: block.type
		};
		if (block.type === 'heading') inverse.level = block.level;
		if (block.type === 'list_item') inverse.ordered = block.ordered;
		return [inverse];
	}

	const others = documentOrder(page).length - 1;
	if (others >= 1) {
		return [
			{ kind: 'delete-block', id: op.id },
			{
				kind: 'insert-block',
				afterId: prevSiblingId(page, op.id),
				parentId: parentIdOf(parent),
				block: cloneBlock(block)
			}
		];
	}

	const post = convertBlock(block, op);
	const backOp: Extract<Op, { kind: 'convert-block' }> = {
		kind: 'convert-block',
		id: op.id,
		to: block.type
	};
	if (block.type === 'heading') backOp.level = block.level;
	if (block.type === 'list_item') backOp.ordered = block.ordered;
	const back = convertBlock(post, backOp);
	return [backOp, ...restoreSolePayload(op.id, block, payloadLength(back))];
}

function invertInsertText(page: KbPage, op: Extract<Op, { kind: 'insert-text' }>): Op[] {
	const at = resolvePoint(page, op.at);
	if (op.text === '') return [];
	if (isNonTextual(at.block)) {
		throw new Error('cannot insert text into atomic block');
	}
	if (isTextLike(at.block) && op.text.includes('\n')) {
		throw new Error("newline not allowed in text-like block");
	}
	const head: Point = { blockId: at.block.id, offset: at.offset + op.text.length };
	return [
		{
			kind: 'delete-range',
			range: { anchor: { blockId: at.block.id, offset: at.offset }, head }
		}
	];
}

export function invert(page: KbPage, op: Op): Op[] {
	switch (op.kind) {
		case 'set-title':
			return [{ kind: 'set-title', title: page.title }];
		case 'insert-text':
			return invertInsertText(page, op);
		case 'delete-range':
			return invertDeleteRange(page, op);
		case 'format-range':
			return invertFormatRange(page, op);
		case 'split-block':
			return invertSplitBlock(page, op);
		case 'merge-block':
			return invertMergeBlock(page, op);
		case 'insert-block':
			return [{ kind: 'delete-block', id: op.block.id }];
		case 'delete-block': {
			const { block, parent } = requireBlock(page, op.id, 'delete-block');
			if (block.type === 'table_row' || block.type === 'table_cell') {
				throw new Error('delete-block: use table structural ops for cells/rows');
			}
			if (parent === 'page' && page.blocks.length <= 1) return [];
			return [insertBlockOp(page, block)];
		}
		case 'move-block': {
			const loc = requireBlock(page, op.id, 'move-block');
			if (op.afterId === op.id) throw new Error('cannot move block after itself');
			return [
				{
					kind: 'move-block',
					id: op.id,
					afterId: prevSiblingId(page, op.id),
					parentId: parentIdOf(loc.parent)
				}
			];
		}
		case 'convert-block':
			return invertConvertBlock(page, op);
		case 'set-code': {
			const { block } = requireBlock(page, op.id, 'set-code');
			if (block.type !== 'code') throw new Error('set-code: block is not code');
			return [{ kind: 'set-code', id: op.id, language: block.language }];
		}
		case 'set-children':
			return [{ kind: 'set-children', children: [...page.children] }];
		case 'set-toggle': {
			const { block } = requireBlock(page, op.id, 'set-toggle');
			if (block.type !== 'toggle') throw new Error('set-toggle: block is not a toggle');
			return [{ kind: 'set-toggle', id: op.id, open: block.open }];
		}
		case 'insert-table-row':
			return [{ kind: 'delete-table-row', tableId: op.tableId, rowId: op.row.id }];
		case 'insert-table-column':
			return [{ kind: 'delete-table-column', tableId: op.tableId, index: op.index }];
		case 'delete-table-row': {
			const loc = requireBlock(page, op.rowId, 'delete-table-row');
			if (loc.block.type !== 'table_row') {
				throw new Error(`delete-table-row: ${op.rowId} is not a table_row`);
			}
			return [
				{
					kind: 'insert-table-row',
					tableId: op.tableId,
					afterId: prevSiblingId(page, op.rowId),
					row: cloneBlock(loc.block) as TableRowBlock
				}
			];
		}
		case 'delete-table-column': {
			const tableLoc = requireBlock(page, op.tableId, 'delete-table-column');
			if (tableLoc.block.type !== 'table') {
				throw new Error(`delete-table-column: ${op.tableId} is not a table`);
			}
			const cells: TableCellBlock[] = [];
			for (const row of tableLoc.block.children) {
				const cell = row.children[op.index];
				if (!cell) throw new Error('delete-table-column: index out of range');
				cells.push(cloneBlock(cell) as TableCellBlock);
			}
			return [{ kind: 'insert-table-column', tableId: op.tableId, index: op.index, cells }];
		}
		default: {
			const _never: never = op;
			throw new Error(`unknown op: ${(_never as Op).kind}`);
		}
	}
}
