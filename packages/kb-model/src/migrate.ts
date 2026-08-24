import { KB_SCHEMA_VERSION } from './types.js';

/** v1 is the first on-disk version; identity until a v1→v2 field rewrite exists. */
export function migrateV1<T>(page: T): T {
	return page;
}

/** True iff this client can apply/write a page at `version` (file version, not capability). */
export function isSchemaUnderstood(version: number): boolean {
	return version <= KB_SCHEMA_VERSION;
}

/**
 * Smash-save is forbidden when the file is newer than this client, or when parse
 * flattened unknown containers for local display only.
 */
export function schemaWriteAllowed(
	schemaVersion: number,
	opts?: { flattenedUnknown?: boolean }
): boolean {
	return isSchemaUnderstood(schemaVersion) && !opts?.flattenedUnknown;
}

/**
 * Identity for known versions. Does **not** clamp a future schemaVersion down to
 * KB_SCHEMA_VERSION — a v1 client must not smash v2 bytes and save the strip.
 */
export function migrateSchema(raw: Record<string, unknown>): Record<string, unknown> {
	const version = raw.schemaVersion;
	if (typeof version !== 'number') {
		return migrateV1({ ...raw, schemaVersion: 1 });
	}
	if (version <= 1) {
		return migrateV1({ ...raw, schemaVersion: 1 });
	}
	return { ...raw };
}
