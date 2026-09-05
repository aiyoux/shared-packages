import { normalizePage } from './normalize.js';
import { isUnknownBlock } from './plaintext.js';
import type {
	Block,
	Inline,
	KbPage,
	ListItemBlock,
	Mark,
	TableBlock,
	TableRowBlock,
	TextSpan,
	ToggleBlock
} from './types.js';

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

/** Hard breaks render as GFM hard breaks (trailing double space) in flowing blocks. */
function hardBreak(text: string): string {
	return text.replace(/\n/g, '  \n');
}

function gfmCell(row: TableRowBlock, index: number): string {
	const cell = row.children[index];
	const text = cell ? wrapInlines(cell.content) : '';
	// A GFM row cannot contain a raw newline; render cell hard breaks as inline HTML.
	return text.replace(/\n/g, '<br>').replace(/\|/g, '\\|');
}

function renderTable(table: TableBlock): string {
	const rows = table.children;
	if (rows.length === 0) return '';
	const width = Math.max(1, ...rows.map((row) => row.children.length));
	const grid = rows.map((row) => {
		const cols: string[] = [];
		for (let i = 0; i < width; i++) cols.push(gfmCell(row, i));
		return cols;
	});
	const colWidths = Array.from({ length: width }, (_, i) =>
		Math.max(3, ...grid.map((row) => row[i].length))
	);
	const formatRow = (cells: string[]) =>
		`| ${cells.map((cell, i) => cell.padEnd(colWidths[i], ' ')).join(' | ')} |`;
	const sep = `| ${colWidths.map((w) => '-'.repeat(w)).join(' | ')} |`;
	const out = [formatRow(grid[0]), sep];
	for (const row of grid.slice(1)) out.push(formatRow(row));
	return out.join('\n');
}

function quoteMarkdown(md: string): string {
	if (md === '') return '';
	return md
		.split('\n')
		.map((line) => (line === '' ? '>' : `> ${line}`))
		.join('\n');
}

function renderToggle(block: ToggleBlock): string {
	const inner = renderSlice(block.children);
	if (inner === '') return '';
	if (block.open) return inner;
	return `<details>\n\n${inner.endsWith('\n') ? inner : `${inner}\n`}</details>`;
}

function sameListRun(prev: Block | undefined, block: ListItemBlock): boolean {
	return prev?.type === 'list_item' && prev.ordered === block.ordered;
}

function renderBlock(block: Block, orderedIndex: number): string {
	switch (block.type) {
		case 'paragraph':
			return hardBreak(wrapInlines(block.content));
		case 'heading':
			return `${'#'.repeat(block.level)} ${hardBreak(wrapInlines(block.content))}`;
		case 'list_item':
			return `${block.ordered ? `${orderedIndex}. ` : '- '}${hardBreak(wrapInlines(block.content))}`;
		case 'code': {
			const body = block.text.endsWith('\n') ? block.text : `${block.text}\n`;
			return `\`\`\`${block.language}\n${body}\`\`\``;
		}
		case 'divider':
			return '---';
		case 'image':
			return `![${block.alt}](${block.src})`;
		case 'callout':
			return quoteMarkdown(renderSlice(block.children));
		case 'toggle':
			return renderToggle(block);
		case 'table':
			return renderTable(block);
		case 'table_row':
		case 'table_cell':
			// Rendered as part of the parent table (GFM grid).
			return '';
		default: {
			// Unknown block types are preserved in the kb JSON but have no Markdown
			// rendering — derived output silently omits them.
			return '';
		}
	}
}

function separator(prev: Block, next: Block): string {
	// Same-ordered adjacent list_items are one list; a blank line would split them.
	if (next.type === 'list_item' && sameListRun(prev, next)) return '\n';
	return '\n\n';
}

/** Recursively remap a sibling slice. Containers own their children. */
function renderSlice(blocks: Block[]): string {
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
		if (
			rendered === '' &&
			(block.type === 'callout' || block.type === 'toggle' || block.type === 'table')
		) {
			continue;
		}
		// Unknown block types have no Markdown rendering — omit them (and their
		// separators) so derived output stays clean; the kb JSON preserves them.
		if (isUnknownBlock(block)) continue;
		if (prev) chunks.push(separator(prev, block));
		chunks.push(rendered);
		emitted.push(block);
	}
	return chunks.join('');
}

/** Derived Markdown of the page body. Not a loader. */
export function toMarkdown(page: KbPage): string {
	const body = renderSlice(normalizePage(page).blocks);
	if (body === '') return '';
	return body.endsWith('\n') ? body : `${body}\n`;
}
