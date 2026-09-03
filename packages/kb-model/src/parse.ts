import { normalizePage } from './normalize.js';
import { KB_FORMAT, type KbPage } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parse a stored kb document. Unknown top-level keys (e.g. a legacy
 * `schemaVersion`) are ignored on read and dropped on resave.
 */
export function parseKb(raw: string | unknown): KbPage {
	if (typeof raw === 'string' && raw.trim() === '') {
		throw new Error('kb document is empty');
	}
	const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
	if (!isRecord(data)) {
		throw new Error('kb document must be an object');
	}
	if (data.format !== KB_FORMAT) {
		throw new Error(`unknown format: ${String(data.format)}`);
	}
	return normalizePage({
		format: KB_FORMAT,
		id: typeof data.id === 'string' ? data.id : '',
		title: typeof data.title === 'string' ? data.title : '',
		createdAt: typeof data.createdAt === 'string' ? data.createdAt : '',
		updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
		children: Array.isArray(data.children) ? (data.children as string[]) : [],
		blocks: Array.isArray(data.blocks) ? (data.blocks as KbPage['blocks']) : []
	});
}
