import {
	normalizePage,
	type Block,
	type CalloutVariant,
	type KbPage,
	type Mark,
	type TableCellBlock,
	type TableRowBlock,
	type TextSpan
} from '@shared-packages/kb-model';

const STAMP = '2026-01-01T00:00:00.000Z';

export function span(text: string, marks: Mark[] = []): TextSpan {
	return { type: 'text', text, marks };
}

export function para(id: string, text: string, marks: Mark[] = []): Block {
	return { id, type: 'paragraph', content: [span(text, marks)] };
}

export function heading(id: string, text: string, level: 1 | 2 | 3 = 1): Block {
	return { id, type: 'heading', level, content: [span(text)] };
}

export function item(id: string, text: string, ordered = false): Block {
	return { id, type: 'list_item', ordered, content: [span(text)] };
}

export function code(id: string, text: string, language = ''): Block {
	return { id, type: 'code', language, text };
}

export function divider(id: string): Block {
	return { id, type: 'divider' };
}

export function image(id: string, src = 'assets/diagram.png', alt = 'Diagram'): Block {
	return { id, type: 'image', src, alt };
}

export function callout(id: string, kids: Block[], variant: CalloutVariant = 'info'): Block {
	return { id, type: 'callout', variant, children: kids };
}

export function toggle(id: string, kids: Block[], open = true): Block {
	return { id, type: 'toggle', open, children: kids };
}

export function cell(id: string, text: string, header = false): TableCellBlock {
	return header
		? { id, type: 'table_cell', header: true, content: [span(text)] }
		: { id, type: 'table_cell', content: [span(text)] };
}

export function row(id: string, cells: TableCellBlock[]): TableRowBlock {
	return { id, type: 'table_row', children: cells };
}

export function table(id: string, rows: TableRowBlock[]): Block {
	return { id, type: 'table', children: rows };
}

/** Nested container fixture (callout). */
export function nest(id: string, kids: Block[], _text = ''): Block {
	return callout(id, kids);
}

export function page(blocks: Block[], extra: Partial<KbPage> = {}): KbPage {
	return normalizePage({
		format: 'kb',
		id: 'page-1',
		title: 'Title',
		createdAt: STAMP,
		updatedAt: STAMP,
		children: [],
		blocks,
		...extra
	});
}
