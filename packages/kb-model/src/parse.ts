import { migrateSchema } from './migrate.js';
import { normalizePage } from './normalize.js';
import { KB_FORMAT, type KbPage } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseKb(raw: string | unknown): KbPage {
	const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
	if (!isRecord(data)) {
		throw new Error('kb document must be an object');
	}
	if (data.format !== KB_FORMAT) {
		throw new Error(`unknown format: ${String(data.format)}`);
	}
	const migrated = migrateSchema(data);
	const page = {
		format: KB_FORMAT,
		schemaVersion: typeof migrated.schemaVersion === 'number' ? migrated.schemaVersion : 1,
		id: typeof migrated.id === 'string' ? migrated.id : '',
		title: typeof migrated.title === 'string' ? migrated.title : '',
		createdAt: typeof migrated.createdAt === 'string' ? migrated.createdAt : '',
		updatedAt: typeof migrated.updatedAt === 'string' ? migrated.updatedAt : '',
		children: Array.isArray(migrated.children) ? migrated.children : [],
		blocks: Array.isArray(migrated.blocks) ? migrated.blocks : []
	} as KbPage;
	return normalizePage(page);
}
