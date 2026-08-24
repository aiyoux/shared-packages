import {
	apply,
	canonicalMarks,
	isTextLike,
	plaintextOf,
	type Block,
	type KbPage,
	type Op,
	type Range,
	type TextSpan
} from '@shared-packages/kb-model';
import { newBlockId } from './ids.js';
import { clampPoint, isCollapsed, orderedRange } from './range.js';
import type { EditorState } from './state.js';

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

function remapBlock(block: Block): Block {
	const id = newBlockId();
	if (block.type === 'divider') return { id, type: 'divider' };
	return { ...block, id };
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
	return { id: block.id, type: 'paragraph', content };
}

export function sliceBlocks(page: KbPage, range: Range): Block[] {
	if (isCollapsed(range)) return [];
	const { start, end } = orderedRange(page, range);
	const si = page.blocks.findIndex((b) => b.id === start.blockId);
	const ei = page.blocks.findIndex((b) => b.id === end.blockId);
	if (si < 0 || ei < 0) return [];
	const out: Block[] = [];
	for (let i = si; i <= ei; i++) {
		const block = page.blocks[i];
		const from = i === si ? start.offset : 0;
		const to = i === ei ? end.offset : plaintextOf(block).length;
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

export function slicePlaintext(page: KbPage, range: Range): string {
	return sliceBlocks(page, range)
		.map((block) => plaintextOf(block))
		.join('\n');
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

function jsonInsertOps(state: EditorState, at: { blockId: string; offset: number }, jsonBlocks: Block[]): Op[] {
	const ops: Op[] = [];
	const block = state.page.blocks.find((item) => item.id === at.blockId);
	const len = block ? plaintextOf(block).length : 0;
	let afterId: string | null;
	if (block && at.offset > 0 && at.offset < len) {
		ops.push({ kind: 'split-block', at, newId: newBlockId() });
		afterId = at.blockId;
	} else if (at.offset === 0) {
		const index = state.page.blocks.findIndex((item) => item.id === at.blockId);
		afterId = index > 0 ? state.page.blocks[index - 1].id : null;
	} else {
		afterId = at.blockId;
	}
	for (const item of jsonBlocks) {
		const next = remapBlock(item);
		ops.push({ kind: 'insert-block', afterId, block: next });
		afterId = next.id;
	}
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
		ops.push({ kind: 'delete-range', range: live });
		working = { ...state, page: apply(state.page, ops[0]) };
	}
	const rawAt = isCollapsed(live) ? live.anchor : orderedRange(state.page, live).start;
	const at = clampPoint(working.page, rawAt);
	const jsonBlocks = input.json ? parseSlice(input.json) : null;
	if (jsonBlocks && jsonBlocks.length > 0) {
		ops.push(...jsonInsertOps(working, at, jsonBlocks));
		return ops;
	}
	let text = input.plain ?? '';
	if (!text && input.html) text = stripHtml(input.html);
	if (!text) return ops;
	const block = working.page.blocks.find((item) => item.id === at.blockId);
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
	if (isCollapsed(live)) return null;
	const blocks = sliceBlocks(state.page, live);
	return { plain: slicePlaintext(state.page, live), json: serializeSlice(blocks) };
}

export function cutOps(live: Range): Op[] {
	if (isCollapsed(live)) return [];
	return [{ kind: 'delete-range', range: live }];
}
