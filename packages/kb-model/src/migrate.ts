import { KB_SCHEMA_VERSION } from './types.js';

/** v1 is the first on-disk version; identity until v2 exists. */
export function migrateV1<T>(page: T): T {
	return page;
}

export function migrateSchema(raw: Record<string, unknown>): Record<string, unknown> {
	const version = raw.schemaVersion;
	if (typeof version === 'number' && version > KB_SCHEMA_VERSION) {
		return migrateV1({ ...raw, schemaVersion: KB_SCHEMA_VERSION });
	}
	return migrateV1({ ...raw, schemaVersion: KB_SCHEMA_VERSION });
}
