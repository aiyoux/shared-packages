import type { DocBody } from './types.js';
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
	type ToggleBlock,
	type Align,
	type VAlign
} from './types.js';

const MARK_RANK: Record<Mark['type'], number> = {
	bold: 0,
	italic: 1,
	code: 2,
	font_family: 3,
	font_size: 4,
	link: 5
};

const CALLOUT_VARIANTS: ReadonlySet<string> = new Set(['info', 'warning', 'note']);

export function newBlockId(): string {
	return crypto.randomUUID();
}

export function emptySpans(): TextSpan[] {
	return [{ type: 'text', text: '', marks: [] }];
}

export function emptyParagraph(id: string): ParagraphBlock {
	return { id, type: 'paragraph', content: emptySpans() };
}

export function coerceAlign(value: unknown): Align | undefined {
	return value === 'left' || value === 'center' || value === 'right' ? value : undefined;
}

export function coerceVAlign(value: unknown): VAlign | undefined {
	return value === 'top' || value === 'middle' || value === 'bottom' ? value : undefined;
}

function pickAlign<T extends { align?: Align }>(block: T, align?: Align): T {
	if (align) return { ...block, align };
	const { align: _drop, ...rest } = block as T & { align?: Align };
	void _drop;
	return rest as T;
}

function pickVAlign(cell: TableCellBlock, valign?: VAlign): TableCellBlock {
	if (valign) return { ...cell, valign };
	const { valign: _drop, ...rest } = cell;
	void _drop;
	return rest;
}

function pickLineHeight<T extends { lineHeight?: string }>(block: T, lineHeight?: string): T {
	if (lineHeight) return { ...block, lineHeight };
	const { lineHeight: _drop, ...rest } = block as T & { lineHeight?: string };
	void _drop;
	return rest as T;
}

function pickIndent<T extends { indent?: number }>(block: T, indent?: number): T {
	if (indent) return { ...block, indent };
	const { indent: _drop, ...rest } = block as T & { indent?: number };
	void _drop;
	return rest as T;
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

/**
 * Canonicalize a user-supplied font size to `"14px"` / `"12pt"` / `"120%"`.
 * Returns null for anything that would not survive serialization and rendering
 * as a style value — callers treat null as "no override".
 */
export function sanitizeFontSize(raw: string): string | null {
	const match = /^\s*(\d{1,4})(px|pt|%)?\s*$/.exec(raw);
	if (!match) return null;
	const n = Number(match[1]);
	if (n < 1 || n > 999) return null;
	return `${n}${match[2] ?? 'px'}`;
}

/**
 * Canonical unitless line-height (`"1.5"`). Returns null when the value
 * would not be a usable CSS line-height override.
 */
export function sanitizeLineHeight(raw: string): string | null {
	const match = /^\s*(\d(?:\.\d{1,2})?)\s*$/.exec(raw);
	if (!match) return null;
	const n = Number(match[1]);
	if (!Number.isFinite(n) || n < 0.8 || n > 4) return null;
	return String(n);
}

export function coerceLineHeight(value: unknown): string | undefined {
	return typeof value === 'string' ? sanitizeLineHeight(value) ?? undefined : undefined;
}

export const MAX_INDENT = 8;

/** Indent level 1–8. 0 / invalid → undefined (no extra indent). */
export function sanitizeIndent(value: unknown): number | undefined {
	const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	if (!Number.isInteger(n) || n < 1 || n > MAX_INDENT) return undefined;
	return n;
}

/** Payload fields that distinguish two marks of the same type, if any. */
function markPayload(mark: Mark): string | undefined {
	if (mark.type === 'link') return mark.href;
	if (mark.type === 'font_family') return mark.family;
	if (mark.type === 'font_size') return mark.size;
	return undefined;
}

function linkHrefOf(marks: Mark[]): string | null {
	for (const mark of marks) {
		if (mark.type === 'link') return mark.href;
	}
	return null;
}

/**
 * Marks for a caret or insert at `offset`. Link is exclusive at the trailing
 * edge: typing after a hyperlink is plain text; typing inside it stays linked.
 */
export function marksAtCaret(content: TextSpan[], offset: number): Mark[] {
	const spans = content && content.length > 0 ? content : emptySpans();
	const total = spans.reduce((sum, span) => sum + span.text.length, 0);
	if (total === 0 || (spans.length === 1 && spans[0]!.text === '')) return [];
	let pos = 0;
	for (let i = 0; i < spans.length; i++) {
		const span = spans[i]!;
		const next = pos + span.text.length;
		if (offset < pos || offset > next) {
			pos = next;
			continue;
		}
		if (offset > pos && offset < next) return canonicalMarks(span.marks);
		if (offset === next) {
			const right = spans[i + 1];
			const leftHref = linkHrefOf(span.marks);
			const rightHref = right ? linkHrefOf(right.marks) : null;
			if (leftHref && leftHref !== rightHref) {
				return canonicalMarks(span.marks.filter((m) => m.type !== 'link'));
			}
			return canonicalMarks(span.marks);
		}
		if (offset === 0) return canonicalMarks(span.marks);
		const prev = spans[i - 1];
		if (prev) {
			const leftHref = linkHrefOf(prev.marks);
			const rightHref = linkHrefOf(span.marks);
			if (leftHref && leftHref !== rightHref) {
				return canonicalMarks(prev.marks.filter((m) => m.type !== 'link'));
			}
			return canonicalMarks(prev.marks);
		}
		return canonicalMarks(span.marks);
	}
	const last = spans[spans.length - 1]!;
	const href = linkHrefOf(last.marks);
	return canonicalMarks(href ? last.marks.filter((m) => m.type !== 'link') : last.marks);
}

export function marksEqual(a: Mark[], b: Mark[]): boolean {
	const left = canonicalMarks(a);
	const right = canonicalMarks(b);
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		const x = left[i];
		const y = right[i];
		if (x.type !== y.type) return false;
		if (markPayload(x) !== markPayload(y)) return false;
	}
	return true;
}

export function normalizeSpans(spans: TextSpan[]): TextSpan[] {
	const out: TextSpan[] = [];
	for (const span of spans) {
		const text = span.text;
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
	if (rec.type === 'font_family') {
		if (rec.family === 'sans' || rec.family === 'serif' || rec.family === 'mono') {
			return { type: 'font_family', family: rec.family };
		}
		return null;
	}
	if (rec.type === 'font_size' && typeof rec.size === 'string') {
		const size = sanitizeFontSize(rec.size);
		return size ? { type: 'font_size', size } : null;
	}
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

function orderedSpan(span: TextSpan): Inline {
	return {
		type: 'text',
		text: span.text,
		marks: canonicalMarks(span.marks).map((mark) => {
			switch (mark.type) {
				case 'link':
					return { type: 'link', href: mark.href };
				case 'font_family':
					return { type: 'font_family', family: mark.family };
				case 'font_size':
					return { type: 'font_size', size: mark.size };
				default:
					return { type: mark.type };
			}
		})
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
		case 'paragraph': {
			const next: ParagraphBlock = {
				id: block.id,
				type: 'paragraph',
				content: block.content.map(orderedSpan)
			};
			const styled: ParagraphBlock = pickIndent(
				pickLineHeight(pickAlign(next, block.align), block.lineHeight),
				block.indent
			);
			return styled;
		}
		case 'heading': {
			const next: HeadingBlock = {
				id: block.id,
				type: 'heading',
				level: block.level,
				content: block.content.map(orderedSpan)
			};
			const styled: HeadingBlock = pickIndent(
				pickLineHeight(pickAlign(next, block.align), block.lineHeight),
				block.indent
			);
			return styled;
		}
		case 'list_item': {
			const next: ListItemBlock = {
				id: block.id,
				type: 'list_item',
				ordered: block.ordered,
				content: block.content.map(orderedSpan)
			};
			const styled: ListItemBlock = pickIndent(
				pickLineHeight(pickAlign(next, block.align), block.lineHeight),
				block.indent
			);
			return styled;
		}
		case 'code': {
			const next: CodeBlock = {
				id: block.id,
				type: 'code',
				language: block.language,
				text: block.text
			};
			const styled: CodeBlock = pickIndent(next, block.indent);
			return styled;
		}
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
		case 'table_cell': {
			const cell: TableCellBlock = block.header
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
			return pickLineHeight(pickVAlign(pickAlign(cell, block.align), block.valign), block.lineHeight);
		}
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
			return pickIndent(
				pickLineHeight(pickAlign(next, coerceAlign(rec.align)), coerceLineHeight(rec.lineHeight)),
				sanitizeIndent(rec.indent)
			);
		}
		case 'heading': {
			const next: HeadingBlock = {
				id,
				type: 'heading',
				level: headingLevel(rec.level),
				content: coerceSpans(rec.content)
			};
			return pickIndent(
				pickLineHeight(pickAlign(next, coerceAlign(rec.align)), coerceLineHeight(rec.lineHeight)),
				sanitizeIndent(rec.indent)
			);
		}
		case 'list_item': {
			const next: ListItemBlock = {
				id,
				type: 'list_item',
				ordered: rec.ordered === true,
				content: coerceSpans(rec.content)
			};
			return pickIndent(
				pickLineHeight(pickAlign(next, coerceAlign(rec.align)), coerceLineHeight(rec.lineHeight)),
				sanitizeIndent(rec.indent)
			);
		}
		case 'code': {
			const next: CodeBlock = {
				id,
				type: 'code',
				language: typeof rec.language === 'string' ? rec.language : '',
				text: typeof rec.text === 'string' ? rec.text : ''
			};
			return pickIndent(next, sanitizeIndent(rec.indent));
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
			// Unknown types are preserved as-is (lossless across load/save); the
			// editor renders them as opaque placeholders.
			return passthroughBlock(rec);
	}
}

function normalizeCell(rec: Record<string, unknown>, id: string): TableCellBlock {
	const cell: TableCellBlock =
		rec.header === true
			? { id, type: 'table_cell', header: true, content: coerceSpans(rec.content) }
			: { id, type: 'table_cell', content: coerceSpans(rec.content) };
	return pickLineHeight(
		pickVAlign(pickAlign(cell, coerceAlign(rec.align)), coerceVAlign(rec.valign)),
		coerceLineHeight(rec.lineHeight)
	);
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

function normalizeBlockList(raws: unknown[], depth: number): Block[] {
	const out: Block[] = [];
	for (const raw of raws) {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
		const rec = raw as Record<string, unknown>;
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
				out.push(...normalizeBlockList(kids, depth));
				continue;
			}
			out.push(normalizeContainer(rec));
			continue;
		}
		out.push(normalizeLeaf(rec, typeof rec.id === 'string' && rec.id ? rec.id : newBlockId()));
	}
	return out;
}

function normalizeContainer(rec: Record<string, unknown>): CalloutBlock | ToggleBlock {
	const id = typeof rec.id === 'string' && rec.id ? rec.id : newBlockId();
	const kids = Array.isArray(rec.children) ? rec.children : [];
	const children = normalizeBlockList(kids, 1);
	if (rec.type === 'toggle') {
		return { id, type: 'toggle', open: rec.open !== false, children };
	}
	return { id, type: 'callout', variant: calloutVariant(rec.variant), children };
}

export function normalizeBlock(block: Block | Record<string, unknown>): Block {
	const rec = block as Record<string, unknown>;
	const list = normalizeBlockList([rec], 0);
	return list[0] ?? passthroughBlock(rec);
}

/**
 * Normalize a body: blocks only, envelope untouched.
 *
 * `normalizePage` rebuilds the KB envelope field by field, which is right for
 * a file page and wrong for anything else — a record-backed document has no
 * `format` or `createdAt` to rebuild, and blanking them is not a normalization.
 * This keeps whatever envelope the caller has and normalizes the part both
 * backends share.
 */
export function normalizeBody<T extends DocBody>(doc: T): T {
	const blocks = normalizeBlockList(doc.blocks ?? [], 0);
	if (blocks.length === 0) blocks.push(emptyParagraph(newBlockId()));
	return {
		...doc,
		title: typeof doc.title === 'string' ? doc.title : '',
		blocks
	};
}

export function normalizePage(page: KbPage): KbPage {
	const blocks = normalizeBlockList(page.blocks ?? [], 0);
	if (blocks.length === 0) blocks.push(emptyParagraph(newBlockId()));
	return {
		format: KB_FORMAT,
		id: page.id,
		title: typeof page.title === 'string' ? page.title : '',
		createdAt: page.createdAt,
		updatedAt: page.updatedAt,
		children: Array.isArray(page.children) ? [...page.children] : [],
		blocks
	};
}
