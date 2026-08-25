import { isSchemaUnderstood } from './migrate.js';
import { isContainer } from './plaintext.js';
import { blockChildren } from './tree.js';
import {
	KB_FORMAT,
	type Block,
	type CalloutBlock,
	type CalloutVariant,
	type CodeBlock,
	type HeadingBlock,
	type ImageBlock,
	type Inline,
	type KbPage,
	type ListItemBlock,
	type Mark,
	type ParagraphBlock,
	type TableBlock,
	type TableCellBlock,
	type TableRowBlock,
	type TextSpan,
	type ToggleBlock
} from './types.js';

const MARK_RANK: Record<Mark['type'], number> = {
	bold: 0,
	italic: 1,
	code: 2,
	link: 3
};

const CALLOUT_VARIANTS: ReadonlySet<string> = new Set(['info', 'warning', 'note']);

export type NormalizeMeta = {
	flattenedUnknown: boolean;
	tooNew: boolean;
};

type NormalizeCtx = {
	tooNew: boolean;
	flattenedUnknown: boolean;
};

export function newBlockId(): string {
	return crypto.randomUUID();
}

export function emptySpans(): TextSpan[] {
	return [{ type: 'text', text: '', marks: [] }];
}

export function emptyParagraph(id: string): ParagraphBlock {
	return { id, type: 'paragraph', content: emptySpans() };
}

export function emptyCell(id: string, header?: boolean): TableCellBlock {
	return header
		? { id, type: 'table_cell', header: true, content: emptySpans() }
		: { id, type: 'table_cell', content: emptySpans() };
}

export function emptyRow(id: string, width: number): TableRowBlock {
	const cells: TableCellBlock[] = [];
	for (let i = 0; i < Math.max(1, width); i++) cells.push(emptyCell(newBlockId()));
	return { id, type: 'table_row', children: cells };
}

export function canonicalMarks(marks: Mark[]): Mark[] {
	const byType = new Map<Mark['type'], Mark>();
	for (const mark of marks) byType.set(mark.type, mark);
	return [...byType.values()].sort((a, b) => MARK_RANK[a.type] - MARK_RANK[b.type]);
}

export function marksEqual(a: Mark[], b: Mark[]): boolean {
	const left = canonicalMarks(a);
	const right = canonicalMarks(b);
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		const x = left[i];
		const y = right[i];
		if (x.type !== y.type) return false;
		if (x.type === 'link' && y.type === 'link' && x.href !== y.href) return false;
	}
	return true;
}

export function normalizeSpans(spans: TextSpan[]): TextSpan[] {
	const out: TextSpan[] = [];
	for (const span of spans) {
		const text = span.text.replace(/\n/g, '');
		if (!text) continue;
		const marks = canonicalMarks(span.marks ?? []);
		const prev = out[out.length - 1];
		if (prev && marksEqual(prev.marks, marks)) {
			prev.text += text;
		} else {
			out.push({ type: 'text', text, marks });
		}
	}
	if (out.length === 0) return emptySpans();
	return out;
}

export function splitSpans(content: TextSpan[], offset: number): [TextSpan[], TextSpan[]] {
	const left: TextSpan[] = [];
	const right: TextSpan[] = [];
	let pos = 0;
	for (const span of content) {
		const next = pos + span.text.length;
		if (next <= offset) {
			left.push({ type: 'text', text: span.text, marks: canonicalMarks(span.marks) });
		} else if (pos >= offset) {
			right.push({ type: 'text', text: span.text, marks: canonicalMarks(span.marks) });
		} else {
			const inner = offset - pos;
			left.push({ type: 'text', text: span.text.slice(0, inner), marks: canonicalMarks(span.marks) });
			right.push({ type: 'text', text: span.text.slice(inner), marks: canonicalMarks(span.marks) });
		}
		pos = next;
	}
	return [left, right];
}

export function sliceSpans(content: TextSpan[], from: number, to: number): TextSpan[] {
	const [, rest] = splitSpans(content, from);
	const [mid] = splitSpans(rest, Math.max(0, to - from));
	return mid.filter((span) => span.text.length > 0);
}

function headingLevel(value: unknown, fallback: 1 | 2 | 3 = 1): 1 | 2 | 3 {
	return value === 2 || value === 3 ? value : fallback;
}

function coerceMark(raw: unknown): Mark | null {
	if (!raw || typeof raw !== 'object') return null;
	const rec = raw as Record<string, unknown>;
	if (rec.type === 'bold' || rec.type === 'italic' || rec.type === 'code') return { type: rec.type };
	if (rec.type === 'link' && typeof rec.href === 'string') return { type: 'link', href: rec.href };
	return null;
}

function coerceSpans(raw: unknown): TextSpan[] {
	if (!Array.isArray(raw)) return emptySpans();
	const spans: TextSpan[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const rec = item as Record<string, unknown>;
		const text = typeof rec.text === 'string' ? rec.text : '';
		const marks = Array.isArray(rec.marks)
			? rec.marks.map(coerceMark).filter((m): m is Mark => m != null)
			: [];
		spans.push({ type: 'text', text, marks });
	}
	return normalizeSpans(spans);
}

function plaintextFromUnknown(raw: Record<string, unknown>): string {
	if (typeof raw.text === 'string') return raw.text;
	if (Array.isArray(raw.content)) {
		return raw.content
			.map((item) =>
				item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
					? (item as { text: string }).text
					: ''
			)
			.join('');
	}
	if (typeof raw.alt === 'string') return raw.alt;
	return '';
}

function unknownToParagraph(raw: Record<string, unknown>): ParagraphBlock {
	const id = typeof raw.id === 'string' && raw.id ? raw.id : newBlockId();
	const text = plaintextFromUnknown(raw).replace(/\n/g, ' ');
	return {
		id,
		type: 'paragraph',
		content: text ? [{ type: 'text', text, marks: [] }] : emptySpans()
	};
}

function orderedSpan(span: TextSpan): Inline {
	return {
		type: 'text',
		text: span.text,
		marks: canonicalMarks(span.marks).map((mark) =>
			mark.type === 'link' ? { type: 'link', href: mark.href } : { type: mark.type }
		)
	};
}

function calloutVariant(value: unknown): CalloutVariant {
	return typeof value === 'string' && CALLOUT_VARIANTS.has(value) ? (value as CalloutVariant) : 'info';
}

function passthroughBlock(raw: Record<string, unknown>): Block {
	const id = typeof raw.id === 'string' && raw.id ? raw.id : newBlockId();
	const type = typeof raw.type === 'string' && raw.type ? raw.type : 'unknown';
	const block: Record<string, unknown> = { id, type };
	for (const [key, value] of Object.entries(raw)) {
		if (key === 'id' || key === 'type' || key === 'children') continue;
		block[key] = value;
	}
	if (Array.isArray(raw.children)) {
		block.children = raw.children.map((item) =>
			item && typeof item === 'object' && !Array.isArray(item)
				? passthroughBlock(item as Record<string, unknown>)
				: item
		);
	}
	return block as Block;
}

export function orderedBlock(block: Block): Block {
	switch (block.type) {
		case 'paragraph':
			return { id: block.id, type: 'paragraph', content: block.content.map(orderedSpan) };
		case 'heading':
			return {
				id: block.id,
				type: 'heading',
				level: block.level,
				content: block.content.map(orderedSpan)
			};
		case 'list_item':
			return {
				id: block.id,
				type: 'list_item',
				ordered: block.ordered,
				content: block.content.map(orderedSpan)
			};
		case 'code':
			return { id: block.id, type: 'code', language: block.language, text: block.text };
		case 'divider':
			return { id: block.id, type: 'divider' };
		case 'image':
			return { id: block.id, type: 'image', src: block.src, alt: block.alt };
		case 'callout':
			return {
				id: block.id,
				type: 'callout',
				variant: block.variant,
				children: block.children.map(orderedBlock)
			};
		case 'toggle':
			return {
				id: block.id,
				type: 'toggle',
				open: block.open,
				children: block.children.map(orderedBlock)
			};
		case 'table':
			return {
				id: block.id,
				type: 'table',
				children: block.children.map((row) => orderedBlock(row) as TableRowBlock)
			};
		case 'table_row':
			return {
				id: block.id,
				type: 'table_row',
				children: block.children.map((cell) => orderedBlock(cell) as TableCellBlock)
			};
		case 'table_cell':
			return block.header
				? {
						id: block.id,
						type: 'table_cell',
						header: true,
						content: block.content.map(orderedSpan)
					}
				: {
						id: block.id,
						type: 'table_cell',
						content: block.content.map(orderedSpan)
					};
		default: {
			const rec = block as Block & Record<string, unknown>;
			return passthroughBlock(rec);
		}
	}
}

function normalizeLeaf(rec: Record<string, unknown>, id: string): Block {
	switch (rec.type) {
		case 'paragraph': {
			const next: ParagraphBlock = { id, type: 'paragraph', content: coerceSpans(rec.content) };
			return next;
		}
		case 'heading': {
			const next: HeadingBlock = {
				id,
				type: 'heading',
				level: headingLevel(rec.level),
				content: coerceSpans(rec.content)
			};
			return next;
		}
		case 'list_item': {
			const next: ListItemBlock = {
				id,
				type: 'list_item',
				ordered: rec.ordered === true,
				content: coerceSpans(rec.content)
			};
			return next;
		}
		case 'code': {
			const next: CodeBlock = {
				id,
				type: 'code',
				language: typeof rec.language === 'string' ? rec.language : '',
				text: typeof rec.text === 'string' ? rec.text : ''
			};
			return next;
		}
		case 'divider':
			return { id, type: 'divider' };
		case 'image': {
			const next: ImageBlock = {
				id,
				type: 'image',
				src: typeof rec.src === 'string' ? rec.src : '',
				alt: typeof rec.alt === 'string' ? rec.alt : ''
			};
			return next;
		}
		default:
			return unknownToParagraph(rec);
	}
}

function normalizeCell(rec: Record<string, unknown>, id: string): TableCellBlock {
	return rec.header === true
		? { id, type: 'table_cell', header: true, content: coerceSpans(rec.content) }
		: { id, type: 'table_cell', content: coerceSpans(rec.content) };
}

function cellFromUnknown(raw: Record<string, unknown>): TableCellBlock {
	const id = typeof raw.id === 'string' && raw.id ? raw.id : newBlockId();
	if (raw.type === 'table_cell') return normalizeCell(raw, id);
	return { id, type: 'table_cell', content: coerceSpans(raw.content ?? raw.text) };
}

function normalizeRow(rec: Record<string, unknown>): TableRowBlock {
	const id = typeof rec.id === 'string' && rec.id ? rec.id : newBlockId();
	const kids = Array.isArray(rec.children) ? rec.children : [];
	const cells: TableCellBlock[] = [];
	for (const raw of kids) {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
		const item = raw as Record<string, unknown>;
		if (item.type === 'table' || item.type === 'table_row' || item.type === 'callout' || item.type === 'toggle') {
			continue;
		}
		cells.push(cellFromUnknown(item));
	}
	return { id, type: 'table_row', children: cells };
}

function padRow(row: TableRowBlock, width: number): TableRowBlock {
	if (row.children.length >= width) return row;
	const cells = [...row.children];
	while (cells.length < width) cells.push(emptyCell(newBlockId()));
	return { ...row, children: cells };
}

function normalizeTable(rec: Record<string, unknown>): TableBlock {
	const id = typeof rec.id === 'string' && rec.id ? rec.id : newBlockId();
	const kids = Array.isArray(rec.children) ? rec.children : [];
	const rows: TableRowBlock[] = [];
	for (const raw of kids) {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
		const item = raw as Record<string, unknown>;
		if (item.type === 'table_row') {
			rows.push(normalizeRow(item));
			continue;
		}
		if (item.type === 'table_cell') {
			rows.push({
				id: newBlockId(),
				type: 'table_row',
				children: [normalizeCell(item, typeof item.id === 'string' && item.id ? item.id : newBlockId())]
			});
		}
	}
	if (rows.length === 0) rows.push(emptyRow(newBlockId(), 1));
	const width = Math.max(1, ...rows.map((row) => row.children.length));
	return { id, type: 'table', children: rows.map((row) => padRow(row, width)) };
}

function flattenTableToParagraphs(rec: Record<string, unknown>): ParagraphBlock[] {
	const table = normalizeTable(rec);
	const out: ParagraphBlock[] = [];
	for (const row of table.children) {
		for (const cell of row.children) {
			out.push({ id: cell.id, type: 'paragraph', content: cell.content });
		}
	}
	return out.length > 0 ? out : [emptyParagraph(typeof rec.id === 'string' && rec.id ? rec.id : newBlockId())];
}

function isKnownContainerType(type: unknown): type is 'callout' | 'toggle' {
	return type === 'callout' || type === 'toggle';
}

function isKnownLeafType(type: unknown): boolean {
	return (
		type === 'paragraph' ||
		type === 'heading' ||
		type === 'list_item' ||
		type === 'code' ||
		type === 'divider' ||
		type === 'image'
	);
}

function normalizeBlockList(raws: unknown[], ctx: NormalizeCtx, depth: number): Block[] {
	const out: Block[] = [];
	for (const raw of raws) {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
		const rec = raw as Record<string, unknown>;
		if (ctx.tooNew) {
			out.push(passthroughBlock(rec));
			continue;
		}
		if (rec.type === 'table') {
			if (depth >= 1) {
				out.push(...flattenTableToParagraphs(rec));
				continue;
			}
			out.push(normalizeTable(rec));
			continue;
		}
		if (rec.type === 'table_row') {
			out.push(
				...normalizeRow(rec).children.map((cell) => ({
					id: cell.id,
					type: 'paragraph' as const,
					content: cell.content
				}))
			);
			continue;
		}
		if (rec.type === 'table_cell') {
			const cell = normalizeCell(rec, typeof rec.id === 'string' && rec.id ? rec.id : newBlockId());
			out.push({ id: cell.id, type: 'paragraph', content: cell.content });
			continue;
		}
		if (isKnownContainerType(rec.type)) {
			if (depth >= 1) {
				const kids = Array.isArray(rec.children) ? rec.children : [];
				out.push(...normalizeBlockList(kids, ctx, depth));
				continue;
			}
			out.push(normalizeContainer(rec, ctx));
			continue;
		}
		if (!isKnownLeafType(rec.type) && Array.isArray(rec.children)) {
			ctx.flattenedUnknown = true;
			out.push(...normalizeBlockList(rec.children, ctx, depth));
			continue;
		}
		out.push(normalizeLeaf(rec, typeof rec.id === 'string' && rec.id ? rec.id : newBlockId()));
	}
	return out;
}

function normalizeContainer(rec: Record<string, unknown>, ctx: NormalizeCtx): CalloutBlock | ToggleBlock {
	const id = typeof rec.id === 'string' && rec.id ? rec.id : newBlockId();
	const kids = Array.isArray(rec.children) ? rec.children : [];
	const children = normalizeBlockList(kids, ctx, 1);
	if (rec.type === 'toggle') {
		return { id, type: 'toggle', open: rec.open !== false, children };
	}
	return { id, type: 'callout', variant: calloutVariant(rec.variant), children };
}

export function normalizeBlock(block: Block | Record<string, unknown>): Block {
	const rec = block as Record<string, unknown>;
	const ctx: NormalizeCtx = { tooNew: false, flattenedUnknown: false };
	const list = normalizeBlockList([rec], ctx, 0);
	return list[0] ?? unknownToParagraph(rec);
}

function schemaVersionOf(page: KbPage): number {
	return typeof page.schemaVersion === 'number' ? page.schemaVersion : 1;
}

export function hasNestedTypes(page: KbPage): boolean {
	const walk = (blocks: Block[]): boolean => {
		for (const block of blocks) {
			if (isContainer(block) || block.type === 'table') return true;
			const kids = blockChildren(block);
			if (kids && walk(kids)) return true;
		}
		return false;
	};
	return walk(page.blocks ?? []);
}

/** Stamp schemaVersion 2 only when a nested type is present; otherwise keep the page's version. */
export function writeSchemaVersion(page: KbPage): number {
	const current = schemaVersionOf(page);
	if (hasNestedTypes(page)) return Math.max(current, 2);
	return current;
}

export function normalizePage(page: KbPage, meta?: NormalizeMeta): KbPage {
	const schemaVersion = schemaVersionOf(page);
	const ctx: NormalizeCtx = {
		tooNew: !isSchemaUnderstood(schemaVersion),
		flattenedUnknown: false
	};
	const blocks = normalizeBlockList(page.blocks ?? [], ctx, 0);
	if (blocks.length === 0) blocks.push(emptyParagraph(newBlockId()));
	if (meta) {
		meta.flattenedUnknown = ctx.flattenedUnknown;
		meta.tooNew = ctx.tooNew;
	}
	return {
		format: KB_FORMAT,
		schemaVersion,
		id: page.id,
		title: typeof page.title === 'string' ? page.title : '',
		createdAt: page.createdAt,
		updatedAt: page.updatedAt,
		children: Array.isArray(page.children) ? [...page.children] : [],
		blocks
	};
}
