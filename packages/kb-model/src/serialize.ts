import { normalizePage, writeSchemaVersion } from './normalize.js';
import { KB_FORMAT, type KbPage } from './types.js';

export function serializeKb(page: KbPage): string {
	const normalized = normalizePage(page);
	const ordered: KbPage = {
		format: KB_FORMAT,
		schemaVersion: writeSchemaVersion(normalized),
		id: normalized.id,
		title: normalized.title,
		createdAt: normalized.createdAt,
		updatedAt: normalized.updatedAt,
		children: normalized.children,
		blocks: normalized.blocks
	};
	return `${JSON.stringify(ordered, null, 2)}\n`;
}
