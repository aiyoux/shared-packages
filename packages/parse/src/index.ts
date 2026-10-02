/**
 * The one parse vocabulary for every document format reader.
 *
 * Each format package copy-pasted these when there was one format; now
 * eight readers re-declare them, and they had already drifted (optionalId
 * accepted whitespace-only ids in four copies). These are primitives, not
 * policy: format-specific steps stay in each reader.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Non-empty string, else undefined. Whitespace-only reads as absent. */
export function optionalId(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value.trim()) return undefined;
	return value;
}

/**
 * A finite number or a parse error naming the field. `makeError` wraps the
 * message in the reader's own error class when callers catch a specific one.
 */
export function finiteNumber(
	value: unknown,
	field: string,
	makeError?: (message: string) => Error
): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		const message = `${field} must be a finite number`;
		throw makeError ? makeError(message) : new Error(message);
	}
	return value;
}

/**
 * Mint a document id. crypto.randomUUID wins where it exists — note the
 * prefix applies only to the fallback, as in every copy this replaces.
 */
export function mintDocId(prefix = 'doc'): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}