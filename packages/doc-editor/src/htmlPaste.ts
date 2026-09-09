import {
	canonicalMarks,
	marksEqual,
	MAX_INDENT,
	paintMarkFromCss,
	sanitizeIndent,
	type Block,
	type ListItemBlock,
	type Mark,
	type PaintMark,
	type TableBlock,
	type TableCellBlock,
	type TableRowBlock,
	type TextSpan
} from '@shared-packages/doc-model';
import { allowlistedHref } from './href.js';
import { newBlockId } from './ids.js';

type MarkState = {
	bold: boolean;
	italic: boolean;
	underline: boolean;
	color: PaintMark | null;
	highlight: PaintMark | null;
	code: boolean;
	href: string | null;
};

const SKIP_TAGS = new Set([
	'script',
	'style',
	'meta',
	'link',
	'head',
	'title',
	'noscript',
	'iframe',
	'object',
	'embed',
	'svg',
	'canvas',
	'img'
]);

function extractFragment(html: string): string {
	const start = html.indexOf('<!--StartFragment-->');
	const end = html.indexOf('<!--EndFragment-->');
	if (start >= 0 && end > start) return html.slice(start + '<!--StartFragment-->'.length, end);
	return html;
}

function parseBody(html: string): Element | null {
	if (typeof DOMParser === 'undefined') return null;
	try {
		const doc = new DOMParser().parseFromString(extractFragment(html), 'text/html');
		return doc.body;
	} catch {
		return null;
	}
}

function tag(el: Element): string {
	return el.tagName.toLowerCase();
}

function styleOf(el: Element): string {
	return el.getAttribute('style') || '';
}

function classOf(el: Element): string {
	return el.getAttribute('class') || '';
}

function styleValue(style: string, prop: string): string | null {
	const re = new RegExp(`${prop}\\s*:\\s*([^;]+)`, 'i');
	const m = re.exec(style);
	return m ? m[1].trim().toLowerCase() : null;
}

function nextMarks(el: Element, parent: MarkState): MarkState {
	const style = styleOf(el);
	const name = tag(el);
	let { bold, italic, underline, color, highlight, code, href } = parent;
	const weight = styleValue(style, 'font-weight');
	if (weight === 'normal' || weight === '400') bold = false;
	else if (weight === 'bold' || (weight != null && parseInt(weight, 10) >= 600)) bold = true;
	else if (name === 'b' || name === 'strong') bold = true;
	const fontStyle = styleValue(style, 'font-style');
	if (fontStyle === 'normal') italic = false;
	else if (fontStyle === 'italic' || fontStyle === 'oblique') italic = true;
	else if (name === 'i' || name === 'em') italic = true;
	const decoration = styleValue(style, 'text-decoration') ?? styleValue(style, 'text-decoration-line');
	if (decoration === 'none') underline = false;
	else if (decoration != null && /\bunderline\b/.test(decoration) && name !== 'a') underline = true;
	else if (name === 'u' || name === 'ins') underline = true;
	const cssColor = styleValue(style, 'color') ?? (name === 'font' ? el.getAttribute('color') : null);
	if (cssColor === 'inherit' || cssColor === 'currentcolor') color = null;
	else if (cssColor && name !== 'a') {
		const next = paintMarkFromCss('color', cssColor);
		if (next) color = next;
	}
	const cssBg = styleValue(style, 'background-color') ?? styleValue(style, 'background');
	if (cssBg === 'transparent' || cssBg === 'none' || cssBg === 'inherit') highlight = null;
	else if (cssBg) {
		const next = paintMarkFromCss('highlight', cssBg);
		if (next) highlight = next;
	} else if (name === 'mark') {
		highlight = highlight ?? { type: 'highlight', color: 'yellow' };
	}
	if (name === 'code' || name === 'kbd' || name === 'samp' || name === 'tt') code = true;
	if (name === 'a') {
		const raw = el.getAttribute('href');
		const ok = raw ? allowlistedHref(raw) : null;
		if (ok) href = ok;
	}
	return { bold, italic, underline, color, highlight, code, href };
}

function marksFrom(state: MarkState): Mark[] {
	const marks: Mark[] = [];
	if (state.bold) marks.push({ type: 'bold' });
	if (state.italic) marks.push({ type: 'italic' });
	if (state.underline) marks.push({ type: 'underline' });
	if (state.color) marks.push(state.color);
	if (state.highlight) marks.push(state.highlight);
	if (state.code) marks.push({ type: 'code' });
	if (state.href) marks.push({ type: 'link', href: state.href });
	return canonicalMarks(marks);
}

function pushSpan(out: TextSpan[], text: string, marks: Mark[]): void {
	if (!text) return;
	const last = out[out.length - 1];
	if (last && marksEqual(last.marks, marks)) {
		last.text += text;
		return;
	}
	out.push({ type: 'text', text, marks });
}

function isSupportListsStart(node: Node): boolean {
	return node.nodeType === Node.COMMENT_NODE && /\[if\s+!supportLists\]/i.test(node.textContent || '');
}

function isEndif(node: Node): boolean {
	return node.nodeType === Node.COMMENT_NODE && /\[endif\]/i.test(node.textContent || '');
}

function listOrdered(el: Element, fallback: boolean): boolean {
	const lst = styleValue(styleOf(el), 'list-style-type');
	if (!lst) return fallback;
	if (lst === 'disc' || lst === 'circle' || lst === 'square' || lst === 'none') return false;
	if (
		lst === 'decimal' ||
		lst === 'decimal-leading-zero' ||
		lst.includes('roman') ||
		lst.includes('latin') ||
		lst.includes('alpha')
	) {
		return true;
	}
	return fallback;
}

function isMsoList(el: Element): boolean {
	return /mso-list/i.test(styleOf(el)) || /MsoList/i.test(classOf(el));
}

/** Word `mso-list:l0 levelN` → extra indent N-1 (level 1 is the default). */
function msoListIndent(el: Element): number {
	const m = /mso-list\s*:[^;]*\blevel(\d+)/i.exec(styleOf(el));
	if (!m) return 0;
	const n = Number(m[1]);
	if (!Number.isInteger(n) || n < 2) return 0;
	return Math.min(MAX_INDENT, n - 1);
}

function clampIndent(n: number): number {
	return sanitizeIndent(n) ?? 0;
}

function msoOrderedFromMarker(text: string): boolean {
	return /^\d+[.)]/.test(text.replace(/\s+/g, ' ').trim());
}

function normalizePhrasing(raw: string, pre: boolean): string {
	if (pre) return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	return raw.replace(/\s+/g, ' ');
}

function collectInlines(root: Node, inherited: MarkState, pre = false): { spans: TextSpan[]; msoOrdered: boolean | null } {
	const spans: TextSpan[] = [];
	let msoOrdered: boolean | null = null;

	const walk = (node: Node, marks: MarkState): void => {
		if (node.nodeType === Node.COMMENT_NODE) return;
		if (node.nodeType === Node.TEXT_NODE) {
			pushSpan(spans, normalizePhrasing(node.textContent ?? '', pre), marksFrom(marks));
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;
		const el = node as Element;
		const name = tag(el);
		if (SKIP_TAGS.has(name)) return;
		if (name === 'br') {
			pushSpan(spans, '\n', marksFrom(marks));
			return;
		}
		const next = nextMarks(el, marks);
		const kids = el.childNodes;
		for (let i = 0; i < kids.length; i++) {
			const child = kids[i]!;
			if (isSupportListsStart(child)) {
				let marker = '';
				i++;
				while (i < kids.length && !isEndif(kids[i]!)) {
					marker += kids[i]!.textContent ?? '';
					i++;
				}
				if (msoOrdered == null) msoOrdered = msoOrderedFromMarker(marker);
				continue;
			}
			walk(child, next);
		}
	};

	walk(root, inherited);
	return { spans: collapseSpans(spans), msoOrdered };
}

function collapseSpans(spans: TextSpan[]): TextSpan[] {
	const out: TextSpan[] = [];
	for (const span of spans) {
		if (!span.text) continue;
		pushSpan(out, span.text, span.marks);
	}
	if (out.length === 0) return [{ type: 'text', text: '', marks: [] }];
	const joined = out.map((s) => s.text).join('');
	if (!joined.trim()) return [{ type: 'text', text: '', marks: [] }];
	if (out.length === 1) {
		const t = out[0]!.text.replace(/^ /, '').replace(/ $/, '');
		return t ? [{ ...out[0]!, text: t }] : [{ type: 'text', text: '', marks: [] }];
	}
	if (out[0] && /^ +$/.test(out[0].text) === false) {
		out[0] = { ...out[0], text: out[0].text.replace(/^ +/, '') };
	}
	const last = out[out.length - 1];
	if (last) out[out.length - 1] = { ...last, text: last.text.replace(/ +$/, '') };
	return out.filter((s) => s.text.length > 0);
}

function spansHaveText(spans: TextSpan[]): boolean {
	return spans.some((s) => s.text.trim().length > 0);
}

function headingLevel(name: string): 1 | 2 | 3 {
	if (name === 'h1') return 1;
	if (name === 'h2') return 2;
	return 3;
}

function emptySpans(): TextSpan[] {
	return [{ type: 'text', text: '', marks: [] }];
}

function paragraph(spans: TextSpan[]): Block {
	return { id: newBlockId(), type: 'paragraph', content: spansHaveText(spans) ? spans : emptySpans() };
}

function headingBlock(spans: TextSpan[], level: 1 | 2 | 3): Block {
	return { id: newBlockId(), type: 'heading', level, content: spansHaveText(spans) ? spans : emptySpans() };
}

function listItem(spans: TextSpan[], ordered: boolean, indent = 0): ListItemBlock {
	const item: ListItemBlock = {
		id: newBlockId(),
		type: 'list_item',
		ordered,
		content: spansHaveText(spans) ? spans : emptySpans()
	};
	const level = clampIndent(indent);
	if (level) item.indent = level;
	return item;
}

function hasBlockChild(el: Element): boolean {
	for (const child of el.children) {
		const name = tag(child);
		if (
			name === 'p' ||
			name === 'div' ||
			name === 'h1' ||
			name === 'h2' ||
			name === 'h3' ||
			name === 'h4' ||
			name === 'h5' ||
			name === 'h6' ||
			name === 'ul' ||
			name === 'ol' ||
			name === 'li' ||
			name === 'table' ||
			name === 'pre' ||
			name === 'blockquote' ||
			name === 'hr'
		) {
			return true;
		}
	}
	return false;
}

function cellFromElement(el: Element): TableCellBlock {
	const { spans } = collectInlines(el, {
		bold: false,
		italic: false,
		underline: false,
		color: null,
		highlight: null,
		code: false,
		href: null
	});
	const header = tag(el) === 'th';
	const content = spansHaveText(spans) ? spans : emptySpans();
	return header
		? { id: newBlockId(), type: 'table_cell', header: true, content }
		: { id: newBlockId(), type: 'table_cell', content };
}

function tableFromElement(el: Element): TableBlock | null {
	const rowEls = [...el.querySelectorAll('tr')];
	const rows: TableRowBlock[] = [];
	for (const rowEl of rowEls) {
		const cells: TableCellBlock[] = [];
		for (const child of rowEl.children) {
			const name = tag(child);
			if (name === 'td' || name === 'th') cells.push(cellFromElement(child));
		}
		if (cells.length === 0) continue;
		rows.push({ id: newBlockId(), type: 'table_row', children: cells });
	}
	if (rows.length === 0) return null;
	const width = Math.max(...rows.map((r) => r.children.length), 1);
	for (const row of rows) {
		while (row.children.length < width) {
			row.children.push({ id: newBlockId(), type: 'table_cell', content: emptySpans() });
		}
	}
	return { id: newBlockId(), type: 'table', children: rows };
}

function emitBlocks(root: Node, out: Block[], inherited: MarkState, listDepth = 0): void {
	if (root.nodeType === Node.TEXT_NODE) {
		const text = normalizePhrasing(root.textContent ?? '', false).trim();
		if (text) out.push(paragraph([{ type: 'text', text, marks: marksFrom(inherited) }]));
		return;
	}
	if (root.nodeType !== Node.ELEMENT_NODE) return;
	const el = root as Element;
	const name = tag(el);
	if (SKIP_TAGS.has(name)) return;

	if (name === 'br') {
		out.push(paragraph(emptySpans()));
		return;
	}
	if (name === 'hr') {
		out.push({ id: newBlockId(), type: 'divider' });
		return;
	}
	if (name === 'pre') {
		const { spans } = collectInlines(el, inherited, true);
		out.push({
			id: newBlockId(),
			type: 'code',
			language: '',
			text: spans.map((s) => s.text).join('')
		});
		return;
	}
	if (name === 'table') {
		const table = tableFromElement(el);
		if (table) out.push(table);
		return;
	}
	if (name === 'ul' || name === 'ol') {
		const ordered = listOrdered(el, name === 'ol');
		for (const child of el.children) {
			const childName = tag(child);
			if (childName === 'li') {
				emitListItem(child, out, inherited, listOrdered(child, ordered), listDepth);
			} else if (childName === 'ul' || childName === 'ol') {
				emitBlocks(child, out, inherited, Math.min(MAX_INDENT, listDepth + 1));
			}
		}
		return;
	}
	if (name === 'li') {
		emitListItem(el, out, inherited, false, listDepth);
		return;
	}

	if (name === 'h1' || name === 'h2' || name === 'h3' || name === 'h4' || name === 'h5' || name === 'h6') {
		const { spans } = collectInlines(el, inherited);
		if (spansHaveText(spans)) out.push(headingBlock(spans, headingLevel(name)));
		return;
	}

	if (name === 'blockquote') {
		for (const child of el.childNodes) emitBlocks(child, out, inherited);
		return;
	}

	const msoList = isMsoList(el);
	if (msoList && !hasBlockChild(el)) {
		const { spans, msoOrdered } = collectInlines(el, inherited);
		if (spansHaveText(spans)) out.push(listItem(spans, msoOrdered === true, msoListIndent(el)));
		return;
	}

	if (hasBlockChild(el)) {
		for (const child of el.childNodes) emitBlocks(child, out, nextMarks(el, inherited));
		return;
	}

	if (
		name === 'p' ||
		name === 'div' ||
		name === 'body' ||
		name === 'section' ||
		name === 'article'
	) {
		const { spans } = collectInlines(el, inherited);
		if (spansHaveText(spans)) out.push(paragraph(spans));
		return;
	}

	// Phrasing leftover at the top level (e.g. a bare <b>hello</b>).
	const { spans } = collectInlines(el, inherited);
	if (spansHaveText(spans)) out.push(paragraph(spans));
}

function emitListItem(
	el: Element,
	out: Block[],
	inherited: MarkState,
	ordered: boolean,
	indent: number
): void {
	const nested: Element[] = [];
	const cloneKids: Node[] = [];
	for (const child of el.childNodes) {
		if (child.nodeType === Node.ELEMENT_NODE && (tag(child as Element) === 'ul' || tag(child as Element) === 'ol')) {
			nested.push(child as Element);
		} else {
			cloneKids.push(child);
		}
	}
	const probe = el.ownerDocument.createElement('div');
	for (const child of cloneKids) probe.appendChild(child.cloneNode(true));
	const { spans, msoOrdered } = collectInlines(probe, inherited);
	const orderedFlag = msoOrdered == null ? ordered : msoOrdered;
	if (spansHaveText(spans) || nested.length === 0) out.push(listItem(spans, orderedFlag, indent));
	for (const nest of nested) emitBlocks(nest, out, inherited, Math.min(MAX_INDENT, indent + 1));
}

/**
 * Map pasted HTML (Word, Google Docs, browsers) onto KB blocks.
 * Returns [] when the payload has no usable structure — callers fall back to
 * plaintext. Never executes scripts; hrefs go through `allowlistedHref`.
 */
export function htmlToBlocks(html: string): Block[] {
	if (!html.trim()) return [];
	const body = parseBody(html);
	if (!body) return [];
	const out: Block[] = [];
	emitBlocks(body, out, {
		bold: false,
		italic: false,
		underline: false,
		color: null,
		highlight: null,
		code: false,
		href: null
	});
	return out.filter((b) => {
		if (b.type === 'divider' || b.type === 'table' || b.type === 'code') return true;
		if ('content' in b) return spansHaveText(b.content);
		return true;
	});
}
