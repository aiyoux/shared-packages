import { normalizePage } from './normalize.js';
import { blockChildren, documentOrder } from './tree.js';
import type { Block, Inline, KbPage, ListItemBlock, Mark, TableBlock, TableRowBlock, TextSpan } from './types.js';

function linkHref(marks: Mark[]): string | null {
	let href: string | null = null;
	for (const mark of marks) {
		if (mark.type === 'link') href = mark.href;
	}
	return href;
}

function hasMark(marks: Mark[], type: Exclude<Mark['type'], 'link'>): boolean {
	return marks.some((mark) => mark.type === type);
}

function wrapSpan(span: TextSpan): string {
	let text = span.text;
	const marks = span.marks;
	// Innermost code then italic then bold; link outermost so [**x**](href) reads naturally.
	if (hasMark(marks, 'code')) text = `\`${text}\``;
	if (hasMark(marks, 'italic')) text = `*${text}*`;
	if (hasMark(marks, 'bold')) text = `**${text}**`;
	const href = linkHref(marks);
	if (href != null) text = `[${text}](${href})`;
	return text;
}

function wrapInlines(spans: Inline[]): string {
	return spans.map(wrapSpan).join('');
}

function gfmCell(row: TableRowBlock, index: number): string {
	const cell = row.children[index];
	const text = cell ? wrapInlines(cell.content) : '';
	return text.replace(/\|/g, '\\|');
}

function renderTable(table: TableBlock): string {
	const rows = table.children;
	if (rows.length === 0) return '';
	const width = Math.max(1, ...rows.map((row) => row.children.length));
	const line = (row: TableRowBlock) => {
		const cols: string[] = [];
		for (let i = 0; i < width; i++) cols.push(gfmCell(row, i));
		return `| ${cols.join(' | ')} |`;
	};
	const sep = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
	const out = [line(rows[0]), sep];
	for (const row of rows.slice(1)) out.push(line(row));
	return out.join('\n');
}

function sameListRun(prev: Block | undefined, block: ListItemBlock): boolean {
	return prev?.type === 'list_item' && prev.ordered === block.ordered;
}

function renderBlock(block: Block, orderedIndex: number): string {
	switch (block.type) {
		case 'paragraph':
			return wrapInlines(block.content);
		case 'heading':
			return `${'#'.repeat(block.level)} ${wrapInlines(block.content)}`;
		case 'list_item':
			return `${block.ordered ? `${orderedIndex}. ` : '- '}${wrapInlines(block.content)}`;
		case 'code': {
			const body = block.text.endsWith('\n') ? block.text : `${block.text}\n`;
			return `\`\`\`${block.language}\n${body}\`\`\``;
		}
		case 'divider':
			return '---';
		case 'image':
			return `![${block.alt}](${block.src})`;
		case 'callout':
		case 'toggle':
			// Chrome is not textual; children render via documentOrder DFS.
			return '';
		case 'table':
			return renderTable(block);
		case 'table_row':
		case 'table_cell':
			// Rendered as part of the parent table (GFM grid).
			return '';
		default: {
			return '';
		}
	}
}

function separator(prev: Block, next: Block): string {
	// Same-ordered adjacent list_items are one list; a blank line would split them.
	if (next.type === 'list_item' && sameListRun(prev, next)) return '\n';
	return '\n\n';
}

/** Derived Markdown of the page body. Not a loader. */
export function toMarkdown(page: KbPage): string {
	const blocks = documentOrder(normalizePage(page));
	const chunks: string[] = [];
	const emitted: Block[] = [];
	let orderedIndex = 0;
	for (const block of blocks) {
		if (block.type === 'table_row' || block.type === 'table_cell') continue;
		const prev = emitted[emitted.length - 1];
		if (block.type === 'list_item' && block.ordered) {
			orderedIndex = sameListRun(prev, block) ? orderedIndex + 1 : 1;
		} else {
			orderedIndex = 0;
		}
		const rendered = renderBlock(block, orderedIndex);
		if (rendered === '' && (blockChildren(block)?.length ?? 0) > 0) continue;
		if (prev) chunks.push(separator(prev, block));
		chunks.push(rendered);
		emitted.push(block);
	}
	const body = chunks.join('');
	if (body === '') return '';
	return body.endsWith('\n') ? body : `${body}\n`;
}
