import { emptyParagraph, newBlockId } from './normalize.js';
import { KB_FORMAT, KB_SCHEMA_VERSION, type KbPage } from './types.js';

export function createEmptyPage(input: { id: string; title: string }): KbPage {
	const now = new Date().toISOString();
	return {
		format: KB_FORMAT,
		schemaVersion: KB_SCHEMA_VERSION,
		id: input.id,
		title: input.title,
		createdAt: now,
		updatedAt: now,
		children: [],
		blocks: [emptyParagraph(newBlockId())]
	};
}
