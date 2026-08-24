import { isSchemaUnderstood, migrateSchema, schemaWriteAllowed } from './migrate.js';
import { normalizePage, type NormalizeMeta } from './normalize.js';
import { KB_FORMAT, type KbPage } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

export type ParsedKb = {
	page: KbPage;
	schemaVersion: number;
	understood: boolean;
	flattenedUnknown: boolean;
	/** False when the caller must not smash-save (too-new schema or local unknown flatten). */
	writable: boolean;
};

export function parseKbDocument(raw: string | unknown): ParsedKb {
	const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
	if (!isRecord(data)) {
		throw new Error('kb document must be an object');
	}
	if (data.format !== KB_FORMAT) {
		throw new Error(`unknown format: ${String(data.format)}`);
	}
	const migrated = migrateSchema(data);
	const schemaVersion = typeof migrated.schemaVersion === 'number' ? migrated.schemaVersion : 1;
	const meta: NormalizeMeta = { flattenedUnknown: false, tooNew: false };
	const page = normalizePage(
		{
			format: KB_FORMAT,
			schemaVersion,
			id: typeof migrated.id === 'string' ? migrated.id : '',
			title: typeof migrated.title === 'string' ? migrated.title : '',
			createdAt: typeof migrated.createdAt === 'string' ? migrated.createdAt : '',
			updatedAt: typeof migrated.updatedAt === 'string' ? migrated.updatedAt : '',
			children: Array.isArray(migrated.children) ? (migrated.children as string[]) : [],
			blocks: Array.isArray(migrated.blocks) ? (migrated.blocks as KbPage['blocks']) : []
		},
		meta
	);
	const understood = isSchemaUnderstood(page.schemaVersion);
	return {
		page,
		schemaVersion: page.schemaVersion,
		understood,
		flattenedUnknown: meta.flattenedUnknown,
		writable: schemaWriteAllowed(page.schemaVersion, { flattenedUnknown: meta.flattenedUnknown })
	};
}

export function parseKb(raw: string | unknown): KbPage {
	return parseKbDocument(raw).page;
}
