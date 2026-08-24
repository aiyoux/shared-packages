import { isTextLike, plaintextOf, type Block, type KbPage, type Op, type Range } from '@shared-packages/kb-model';
import { newBlockId } from './ids.js';
import { isCollapsed, orderedRange } from './range.js';
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

function sliceTextLike(block: Extract<Block, { content: unknown }>, from: number, to: number): Block {
	const text = plaintextOf(block).slice(from, to);
	const content = text
		? [{ type: 'text' as const, text, marks: [] }]
		: [{ type: 'text' as const, text: '', marks: [] }];
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

export function pasteOps(state: EditorState, live: Range, input: { json?: string | null; html?: string | null; plain?: string | null }): Op[] {
	const ops: Op[] = [];
	if (!isCollapsed(live)) ops.push({ kind: 'delete-range', range: live });
	const at = isCollapsed(live) ? live.anchor : orderedRange(state.page, live).start;
	const jsonBlocks = input.json ? parseSlice(input.json) : null;
	if (jsonBlocks && jsonBlocks.length > 0) {
		let afterId: string | null = at.blockId;
		if (at.offset === 0) {
			const index = state.page.blocks.findIndex((b) => b.id === at.blockId);
			afterId = index > 0 ? state.page.blocks[index - 1].id : null;
		}
		for (const block of jsonBlocks) {
			const next = remapBlock(block);
			ops.push({ kind: 'insert-block', afterId, block: next });
			afterId = next.id;
		}
		return ops;
	}
	let text = input.plain ?? '';
	if (!text && input.html) text = stripHtml(input.html);
	if (!text) return ops;
	const block = state.page.blocks.find((item) => item.id === at.blockId);
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
