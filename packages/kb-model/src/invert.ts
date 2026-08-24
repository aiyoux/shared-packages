import { convertBlock, normalizeRange, resolvePoint } from './apply.js';
import { sliceSpans } from './normalize.js';
import { isAtomic, isTextLike, payloadLength, plaintextOf } from './plaintext.js';
import type { Block, KbPage, Mark, Op, Point, TextSpan } from './types.js';

function cloneBlock(block: Block): Block {
	return structuredClone(block);
}

function prevSiblingId(page: KbPage, index: number): string | null {
	return index > 0 ? page.blocks[index - 1].id : null;
}

function requireBlock(page: KbPage, id: string, what: string): { block: Block; index: number } {
	const index = page.blocks.findIndex((item) => item.id === id);
	if (index < 0) throw new Error(`${what}: unknown block ${id}`);
	return { block: page.blocks[index], index };
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

function invertDeleteRange(page: KbPage, op: Extract<Op, { kind: 'delete-range' }>): Op[] {
	const { start, end } = normalizeRange(page, op.range);
	if (start.index === end.index && start.offset === end.offset) return [];

	if (start.index === end.index) {
		if (isAtomic(start.block)) {
			return [
				{
					kind: 'insert-block',
					afterId: prevSiblingId(page, start.index),
					block: cloneBlock(start.block)
				}
			];
		}
		return insertSlice(start.block, start.offset, end.offset, start.offset);
	}

	const startBlock = start.block;
	const endBlock = end.block;
	const middles = page.blocks.slice(start.index + 1, end.index);
	const ops: Op[] = [];
	const startSurvives = !isAtomic(startBlock);
	const canConcat =
		startSurvives &&
		(isTextLike(startBlock) || startBlock.type === 'code') &&
		(isTextLike(endBlock) || endBlock.type === 'code');

	if (canConcat) {
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
		ops.push(...insertSlice(startBlock, start.offset, payloadLength(startBlock), start.offset));
		let afterId = startBlock.id;
		for (const block of [...middles, endBlock]) {
			ops.push({ kind: 'insert-block', afterId, block: cloneBlock(block) });
			afterId = block.id;
		}
		return ops;
	}

	if (startSurvives) {
		ops.push(...insertSlice(startBlock, start.offset, payloadLength(startBlock), start.offset));
		let afterId = startBlock.id;
		for (const block of middles) {
			ops.push({ kind: 'insert-block', afterId, block: cloneBlock(block) });
			afterId = block.id;
		}
		return ops;
	}

	if (!isAtomic(endBlock) && end.offset > 0) {
		ops.push(...insertSlice(endBlock, 0, end.offset, 0));
	}
	let afterId = prevSiblingId(page, start.index);
	for (const block of [startBlock, ...middles]) {
		ops.push({ kind: 'insert-block', afterId, block: cloneBlock(block) });
		afterId = block.id;
	}
	return ops;
}

function findLinkHref(page: KbPage, range: Extract<Op, { kind: 'format-range' }>['range']): string | null {
	const { start, end } = normalizeRange(page, range);
	for (let i = start.index; i <= end.index; i++) {
		const block = page.blocks[i];
		if (!isTextLike(block)) continue;
		const from = i === start.index ? start.offset : 0;
		const to = i === end.index ? end.offset : plaintextOf(block).length;
		for (const span of sliceSpans(block.content, from, to)) {
			const link = span.marks.find((mark): mark is Extract<Mark, { type: 'link' }> => mark.type === 'link');
			if (link) return link.href;
		}
	}
	return null;
}

function invertFormatRange(page: KbPage, op: Extract<Op, { kind: 'format-range' }>): Op[] {
	const { start, end } = normalizeRange(page, op.range);
	if (start.index === end.index && start.offset === end.offset) return [];
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
	if (drop.index !== keep.index + 1) {
		throw new Error('merge-block: dropId must be the immediate next sibling of keepId');
	}
	if (isAtomic(keep.block)) {
		throw new Error('cannot merge into atomic block');
	}
	const dropSnap = cloneBlock(drop.block);
	if (isAtomic(drop.block)) {
		return [{ kind: 'insert-block', afterId: op.keepId, block: dropSnap }];
	}

	const keepLen = payloadLength(keep.block);

	// split-block on code is only legal at an empty last line, so restore via delete+insert.
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
		ops.push({ kind: 'insert-block', afterId: op.keepId, block: dropSnap });
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
	const { block, index } = requireBlock(page, op.id, 'convert-block');
	if (op.to === 'image') {
		throw new Error('cannot convert to image');
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

	const others = page.blocks.length - 1;
	if (others >= 1) {
		return [
			{ kind: 'delete-block', id: op.id },
			{ kind: 'insert-block', afterId: prevSiblingId(page, index), block: cloneBlock(block) }
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
	if (op.text === '') return [];
	const at = resolvePoint(page, op.at);
	if (isAtomic(at.block)) {
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
			if (page.blocks.length <= 1) return [];
			const { index, block } = requireBlock(page, op.id, 'delete-block');
			return [{ kind: 'insert-block', afterId: prevSiblingId(page, index), block: cloneBlock(block) }];
		}
		case 'move-block': {
			const { index } = requireBlock(page, op.id, 'move-block');
			if (op.afterId === op.id) throw new Error('cannot move block after itself');
			return [{ kind: 'move-block', id: op.id, afterId: prevSiblingId(page, index) }];
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
		default: {
			const _never: never = op;
			throw new Error(`unknown op: ${(_never as Op).kind}`);
		}
	}
}
