import { normalizePage, type Block, type KbPage, type Mark, type TextSpan } from '@shared-packages/kb-model';

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

export function page(blocks: Block[], extra: Partial<KbPage> = {}): KbPage {
	return normalizePage({
		format: 'kb',
		schemaVersion: 1,
		id: 'page-1',
		title: 'Title',
		createdAt: STAMP,
		updatedAt: STAMP,
		children: [],
		blocks,
		...extra
	});
}
