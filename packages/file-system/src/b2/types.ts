/**
 * B2 connections live on monitor daemons, not in the browser.
 *
 * A monitor holds the application keys (write-only over the wire) and does
 * every B2 call; any tab that can use that monitor sees its connections.
 * The hub addresses one as `${monitorProfileId}.${connectionId}`.
 * @see ~/Code/monitor docs/design/b2-feature.md
 */

/** One connection as a monitor reports it — never the key. */
export type MonitorB2Connection = {
	id: string;
	name: string;
	keyId: string;
	bucket: string;
	/** Empty, or ends with `/`. */
	namePrefix: string;
	/** `a1b2…9f3c` of the stored key; absent only on malformed rows. */
	keyFingerprint?: string;
};

/** A connection plus the monitor that holds it. */
export type B2ConnectionRow = MonitorB2Connection & {
	/** `${monitorProfileId}.${connectionId}` — the hub-wide id. */
	rowId: string;
	monitorProfileId: string;
	monitorName: string;
	monitorBaseUrl: string;
};

/** Fields for install; `key` is required on create and optional on edit. */
export type B2ConnectionInput = {
	name: string;
	keyId: string;
	key?: string;
	bucket: string;
	namePrefix?: string;
};

export function b2RowId(monitorProfileId: string, connectionId: string): string {
	return `${monitorProfileId}.${connectionId}`;
}

/** Split a row id; monitor profile ids are UUIDs, so the first `.` splits. */
export function parseB2RowId(rowId: string): { monitorProfileId: string; connectionId: string } | null {
	const i = rowId.indexOf('.');
	if (i <= 0 || i === rowId.length - 1) return null;
	return { monitorProfileId: rowId.slice(0, i), connectionId: rowId.slice(i + 1) };
}

export function normalizeNamePrefix(raw?: string | null): string {
	const t = (raw ?? '').trim().replace(/^\/+/, '');
	if (!t) return '';
	return t.endsWith('/') ? t : `${t}/`;
}

/**
 * Form checks that need no network. The monitor authorizes the key on save
 * and refuses master / unscoped / wrong-bucket keys itself.
 */
export function validateB2Input(
	input: B2ConnectionInput,
	opts: { requireKey: boolean }
): string | null {
	if (!input.name.trim()) return 'Name is required';
	if (!input.keyId.trim()) return 'Application key ID is required';
	if (opts.requireKey && !(input.key ?? '').trim()) return 'Application key is required';
	if (!input.bucket.trim()) return 'Bucket name is required';
	if (input.bucket.includes('/')) return 'Bucket name must not contain /';
	return null;
}
