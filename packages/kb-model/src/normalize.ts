import {
	KB_FORMAT,
	KB_SCHEMA_VERSION,
	type Block,
	type CodeBlock,
	type HeadingBlock,
	type ImageBlock,
	type Inline,
	type KbPage,
	type ListItemBlock,
	type Mark,
	type ParagraphBlock,
	type TextSpan
} from './types.js';

const MARK_RANK: Record<Mark['type'], number> = {
	bold: 0,
	italic: 1,
	code: 2,
	link: 3
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
	}
}

export function normalizeBlock(block: Block | Record<string, unknown>): Block {
	const rec = block as Record<string, unknown>;
	const id = typeof rec.id === 'string' && rec.id ? rec.id : newBlockId();
	switch (rec.type) {
		case 'paragraph': {
			const next: ParagraphBlock = { id, type: 'paragraph', content: coerceSpans(rec.content) };
			return orderedBlock(next);
		}
		case 'heading': {
			const next: HeadingBlock = {
				id,
				type: 'heading',
				level: headingLevel(rec.level),
				content: coerceSpans(rec.content)
			};
			return orderedBlock(next);
		}
		case 'list_item': {
			const next: ListItemBlock = {
				id,
				type: 'list_item',
				ordered: rec.ordered === true,
				content: coerceSpans(rec.content)
			};
			return orderedBlock(next);
		}
		case 'code': {
			const next: CodeBlock = {
				id,
				type: 'code',
				language: typeof rec.language === 'string' ? rec.language : '',
				text: typeof rec.text === 'string' ? rec.text : ''
			};
			return orderedBlock(next);
		}
		case 'divider':
			return orderedBlock({ id, type: 'divider' });
		case 'image': {
			const next: ImageBlock = {
				id,
				type: 'image',
				src: typeof rec.src === 'string' ? rec.src : '',
				alt: typeof rec.alt === 'string' ? rec.alt : ''
			};
			return orderedBlock(next);
		}
		default:
			return orderedBlock(unknownToParagraph(rec));
	}
}

export function normalizePage(page: KbPage): KbPage {
	const blocks = (page.blocks ?? []).map((block) => normalizeBlock(block));
	if (blocks.length === 0) blocks.push(emptyParagraph(newBlockId()));
	return {
		format: KB_FORMAT,
		schemaVersion: KB_SCHEMA_VERSION,
		id: page.id,
		title: typeof page.title === 'string' ? page.title : '',
		createdAt: page.createdAt,
		updatedAt: page.updatedAt,
		children: Array.isArray(page.children) ? [...page.children] : [],
		blocks
	};
}
