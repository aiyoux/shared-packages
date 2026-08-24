import {
	apply,
	blockChildren,
	canonicalMarks,
	childrenOf,
	documentOrder,
	findBlock,
	isContainer,
	isNonTextual,
	isTableStructure,
	isTextLike,
	parentOf,
	plaintextOf,
	type Block,
	type KbPage,
	type Op,
	type Range,
	type TableBlock,
	type TextSpan
} from '@shared-packages/kb-model';
import { newBlockId } from './ids.js';
import { clampPoint, deleteRangeOps, isCollapsed, orderedRange, parentIdFor, textInsertPoint } from './range.js';
import type { EditorState } from './state.js';
import {
	afterTableId,
	cellPlaintext,
	deleteRowOps,
	parseTsv,
	pasteCellsIntoTable,
	pasteTableAtCell,
	sliceTableRect
} from './table.js';

export const KB_CLIPBOARD_MIME = 'application/x-scratch-kb+json';

export type KbSlice = {
	format: 'kb-slice';
	blocks: Block[];
};

export function stripHtml(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n')
		.replace(/<\/div>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'");
}

/** Walk the subtree and mint a new id for every node. */
export function remapBlock(block: Block): Block {
	const id = newBlockId();
	const next: Block = block.type === 'divider' ? { id, type: 'divider' } : { ...block, id };
	const kids = blockChildren(block);
	if (kids) (next as Block & { children: Block[] }).children = kids.map(remapBlock);
	return next;
}

function sliceSpans(content: TextSpan[], from: number, to: number): TextSpan[] {
	const out: TextSpan[] = [];
	let pos = 0;
	for (const span of content) {
		const next = pos + span.text.length;
		const a = Math.max(from, pos);
		const b = Math.min(to, next);
		if (b > a) {
			out.push({
				type: 'text',
				text: span.text.slice(a - pos, b - pos),
				marks: canonicalMarks(span.marks)
			});
		}
		pos = next;
	}
	return out.filter((span) => span.text.length > 0);
}

function sliceTextLike(block: Extract<Block, { content: TextSpan[] }>, from: number, to: number): Block {
	const sliced = sliceSpans(block.content, from, to);
	const content = sliced.length > 0 ? sliced : [{ type: 'text' as const, text: '', marks: [] }];
	if (block.type === 'heading') return { id: block.id, type: 'heading', level: block.level, content };
	if (block.type === 'list_item') return { id: block.id, type: 'list_item', ordered: block.ordered, content };
	if (block.type === 'table_cell') {
		return block.header
			? { id: block.id, type: 'table_cell', header: true, content }
			: { id: block.id, type: 'table_cell', content };
	}
	return { id: block.id, type: 'paragraph', content };
}

export function sliceBlocks(page: KbPage, range: Range): Block[] {
	if (isCollapsed(range)) return [];
	const rect = sliceTableRect(page, range);
	if (rect) return [rect];
	const { start, end } = orderedRange(page, range);
	const order = documentOrder(page);
	const si = order.findIndex((b) => b.id === start.blockId);
	const ei = order.findIndex((b) => b.id === end.blockId);
	if (si < 0 || ei < 0) return [];
	const skip = new Set<string>();
	const out: Block[] = [];
	function skipDescendants(block: Block): void {
		const kids = blockChildren(block);
		if (!kids) return;
		for (const child of kids) {
			skip.add(child.id);
			skipDescendants(child);
		}
	}
	for (let i = si; i <= ei; i++) {
		const block = order[i];
		if (skip.has(block.id)) continue;
		const from = i === si ? start.offset : 0;
		const to = i === ei ? end.offset : plaintextOf(block).length;
		const kids = blockChildren(block);
		if (kids && kids.length > 0) {
			out.push(structuredClone(block));
			skipDescendants(block);
			continue;
		}
		if (isTextLike(block)) {
			out.push(sliceTextLike(block, from, to));
		} else if (block.type === 'code') {
			out.push({ ...block, text: block.text.slice(from, to) });
		} else if (from === 0 && (i < ei || to > 0)) {
			out.push(block);
		}
	}
	return out;
}

function plaintextOfSlice(block: Block): string {
	const kids = blockChildren(block);
	if (!kids || kids.length === 0) return plaintextOf(block);
	const type = (block as { type: string }).type;
	if (type === 'table_row') return kids.map(plaintextOfSlice).join('\t');
	const nested = kids.map(plaintextOfSlice).join('\n');
	const own = plaintextOf(block);
	return own ? `${own}\n${nested}` : nested;
}

export function slicePlaintext(page: KbPage, range: Range): string {
	return sliceBlocks(page, range).map(plaintextOfSlice).join('\n');
}

export function serializeSlice(blocks: Block[]): string {
	const slice: KbSlice = { format: 'kb-slice', blocks };
	return JSON.stringify(slice);
}

export function parseSlice(raw: string): Block[] | null {
	try {
		const parsed = JSON.parse(raw) as KbSlice;
		if (!parsed || parsed.format !== 'kb-slice' || !Array.isArray(parsed.blocks)) return null;
		return parsed.blocks;
	} catch {
		return null;
	}
}

function pushRemapped(
	ops: Op[],
	items: Block[],
	afterId: string | null,
	parentId: string | null
): void {
	let destParent = parentId;
	let destAfter = afterId;
	for (const item of items) {
		const next = remapBlock(item);
		if ((isContainer(next) || next.type === 'table') && destParent != null) {
			destAfter = destParent;
			destParent = null;
		}
		ops.push({ kind: 'insert-block', afterId: destAfter, parentId: destParent, block: next });
		destAfter = next.id;
	}
}

function jsonInsertOps(state: EditorState, at: { blockId: string; offset: number }, jsonBlocks: Block[]): Op[] {
	const ops: Op[] = [];
	const block = findBlock(state.page, at.blockId);
	if (block?.type === 'code') {
		const text = jsonBlocks.map((item) => plaintextOf(item)).join('\n');
		if (text) return [{ kind: 'insert-text', at, text }];
		pushRemapped(ops, jsonBlocks, at.blockId, parentIdFor(state.page, at.blockId));
		return ops;
	}
	if (block?.type === 'table_cell') {
		if (jsonBlocks.length === 1 && jsonBlocks[0]!.type === 'table') {
			return pasteTableAtCell(state.page, at, jsonBlocks[0] as TableBlock);
		}
		const text = cellPlaintext(jsonBlocks.map((item) => plaintextOf(item)).join(' '));
		if (text) return [{ kind: 'insert-text', at, text }];
		return [];
	}
	if (block && isTableStructure(block)) {
		const afterId = afterTableId(state.page, block.id) ?? at.blockId;
		pushRemapped(ops, jsonBlocks, afterId, null);
		return ops;
	}
	const len = block ? plaintextOf(block).length : 0;
	const parentId = parentIdFor(state.page, at.blockId);
	let afterId: string | null;
	if (block && isTextLike(block) && at.offset > 0 && at.offset < len) {
		ops.push({ kind: 'split-block', at, newId: newBlockId() });
		afterId = at.blockId;
	} else if (at.offset === 0) {
		const loc = parentOf(state.page, at.blockId);
		afterId =
			loc && loc.index > 0 ? childrenOf(state.page, loc.parent)[loc.index - 1].id : null;
	} else {
		afterId = at.blockId;
	}
	pushRemapped(ops, jsonBlocks, afterId, parentId);
	return ops;
}

export function pasteOps(
	state: EditorState,
	live: Range,
	input: { json?: string | null; html?: string | null; plain?: string | null }
): Op[] {
	const ops: Op[] = [];
	let working = state;
	if (!isCollapsed(live)) {
		const del = deleteRangeOps(state.page, live);
		if (del.length > 0) {
			ops.push(...del);
			working = { ...state, page: apply(state.page, del[0]) };
		}
	}
	const rawAt = isCollapsed(live) ? live.anchor : orderedRange(state.page, live).start;
	const clamped = clampPoint(working.page, rawAt);
	const at = textInsertPoint(working.page, clamped) ?? clamped;
	const jsonBlocks = input.json ? parseSlice(input.json) : null;
	if (jsonBlocks && jsonBlocks.length > 0) {
		ops.push(...jsonInsertOps(working, at, jsonBlocks));
		return ops;
	}
	let text = input.plain ?? '';
	if (!text && input.html) text = stripHtml(input.html);
	if (!text) return ops;
	const block = findBlock(working.page, at.blockId);
	if (block?.type === 'table_cell') {
		const tsv = parseTsv(text);
		if (tsv && (tsv.length > 1 || (tsv[0]?.length ?? 0) > 1)) {
			ops.push(...pasteCellsIntoTable(working.page, at, tsv));
			return ops;
		}
		const one = cellPlaintext(text);
		if (one) ops.push({ kind: 'insert-text', at, text: one });
		return ops;
	}
	if (block && isNonTextual(block)) {
		const afterId = isTableStructure(block)
			? (afterTableId(working.page, block.id) ?? at.blockId)
			: at.blockId;
		ops.push({
			kind: 'insert-block',
			afterId,
			parentId: isTableStructure(block) ? null : parentIdFor(working.page, at.blockId),
			block: {
				id: newBlockId(),
				type: 'paragraph',
				content: [{ type: 'text', text, marks: [] }]
			}
		});
		return ops;
	}
	if (block?.type === 'code') {
		ops.push({ kind: 'insert-text', at, text });
		return ops;
	}
	const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
	let blockId = at.blockId;
	let offset = at.offset;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line) {
			ops.push({ kind: 'insert-text', at: { blockId, offset }, text: line });
			offset += line.length;
		}
		if (i < lines.length - 1) {
			const newId = newBlockId();
			ops.push({ kind: 'split-block', at: { blockId, offset }, newId });
			blockId = newId;
			offset = 0;
		}
	}
	return ops;
}

export function copyPayload(state: EditorState, live: Range): { plain: string; json: string } | null {
	if (isCollapsed(live)) {
		if (!state.blockFocus) return null;
		const block = findBlock(state.page, state.blockFocus);
		if (!block || !isNonTextual(block)) return null;
		return { plain: plaintextOfSlice(block), json: serializeSlice([structuredClone(block)]) };
	}
	const blocks = sliceBlocks(state.page, live);
	return { plain: slicePlaintext(state.page, live), json: serializeSlice(blocks) };
}

export function cutOps(page: KbPage, live: Range, blockFocus?: string): Op[] {
	if (isCollapsed(live) && blockFocus) {
		const block = findBlock(page, blockFocus);
		if (block?.type === 'table_row') return deleteRowOps(page, block.id);
		if (block && isNonTextual(block)) return [{ kind: 'delete-block', id: blockFocus }];
	}
	return deleteRangeOps(page, live);
}
