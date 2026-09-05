import { emptyParagraph, newBlockId } from './normalize.js';
import { KB_FORMAT, type KbPage } from './types.js';

export function createEmptyPage(input: { id: string; title: string }): KbPage {
	const now = new Date().toISOString();
	return {
		format: KB_FORMAT,
		id: input.id,
		title: input.title,
		createdAt: now,
		updatedAt: now,
		children: [],
		blocks: [emptyParagraph(newBlockId())]
	};
}
