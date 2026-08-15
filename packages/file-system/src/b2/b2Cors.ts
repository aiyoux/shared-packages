/**
 * Bucket CORS needed for browser upload/download on the B2 data plane.
 * Control-plane calls already go through `/api/b2/proxy`; this only covers
 * `b2_upload_file` / download hosts.
 */

export type ExplorerCorsRule = {
	corsRuleName: string;
	allowedOrigins: readonly string[];
	allowedOperations: readonly string[];
	allowedHeaders: readonly string[] | null;
	exposeHeaders: readonly string[] | null;
	maxAgeSeconds: number;
};

export const B2_EXPLORER_CORS_RULE = 'scratchPadFileExplorer';

export const B2_EXPLORER_CORS_OPS = [
	'b2_upload_file',
	'b2_upload_part',
	'b2_download_file_by_name',
	'b2_download_file_by_id'
] as const;

export const B2_EXPLORER_CORS_HEADERS = [
	'authorization',
	'content-type',
	'x-bz-file-name',
	'x-bz-content-sha1',
	'x-bz-part-number',
	'x-bz-info-*',
	'range'
];

export const B2_EXPLORER_CORS_EXPOSE = [
	'x-bz-file-name',
	'x-bz-content-sha1',
	'x-bz-file-id',
	'content-length',
	'content-type'
];

const UPLOAD_HEADERS = ['authorization', 'content-type', 'x-bz-file-name', 'x-bz-content-sha1'];

/** Does a single allowedOrigins entry cover `origin`? */
export function originAllowedByRule(ruleOrigin: string, origin: string): boolean {
	if (!origin) return false;
	if (ruleOrigin === '*') return true;
	if (ruleOrigin === 'https') return origin.startsWith('https:');
	if (ruleOrigin === origin) return true;
	return false;
}

function headersAllowUpload(allowed: readonly string[] | null): boolean {
	if (!allowed || allowed.length === 0) return false;
	const h = allowed.map((x) => x.toLowerCase());
	if (h.includes('*')) return true;
	return UPLOAD_HEADERS.every(
		(need) => h.includes(need) || (need.startsWith('x-bz-') && h.includes('x-bz-*'))
	);
}

/** True when existing rules already let this page origin upload and download. */
export function corsAllowsBrowserFileIo(
	rules: readonly ExplorerCorsRule[] | undefined,
	origin: string
): boolean {
	if (!rules?.length || !origin) return false;
	return rules.some((r) => {
		if (!r.allowedOrigins.some((o) => originAllowedByRule(o, origin))) return false;
		const ops = new Set(r.allowedOperations);
		if (!B2_EXPLORER_CORS_OPS.every((op) => ops.has(op))) return false;
		return headersAllowUpload(r.allowedHeaders);
	});
}

function uniq(xs: readonly string[]): string[] {
	return [...new Set(xs)];
}

/** Merge a scratch-pad explorer CORS rule for `origin`. */
export function mergeExplorerCorsRules(
	existing: readonly ExplorerCorsRule[] | undefined,
	origin: string
): { next: ExplorerCorsRule[]; changed: boolean } {
	if (!origin) return { next: existing ? [...existing] : [], changed: false };
	if (corsAllowsBrowserFileIo(existing, origin)) {
		return { next: existing ? [...existing] : [], changed: false };
	}
	const rules = existing ? [...existing] : [];
	const idx = rules.findIndex((r) => r.corsRuleName === B2_EXPLORER_CORS_RULE);
	if (idx >= 0) {
		const cur = rules[idx]!;
		const allowedOrigins = cur.allowedOrigins.includes(origin)
			? [...cur.allowedOrigins]
			: [...cur.allowedOrigins, origin];
		rules[idx] = {
			...cur,
			allowedOrigins,
			allowedOperations: uniq([...cur.allowedOperations, ...B2_EXPLORER_CORS_OPS]),
			allowedHeaders: uniq([...(cur.allowedHeaders ?? []), ...B2_EXPLORER_CORS_HEADERS]),
			exposeHeaders: uniq([...(cur.exposeHeaders ?? []), ...B2_EXPLORER_CORS_EXPOSE])
		};
		return { next: rules, changed: true };
	}
	rules.push({
		corsRuleName: B2_EXPLORER_CORS_RULE,
		allowedOrigins: [origin],
		allowedOperations: [...B2_EXPLORER_CORS_OPS],
		allowedHeaders: [...B2_EXPLORER_CORS_HEADERS],
		exposeHeaders: [...B2_EXPLORER_CORS_EXPOSE],
		maxAgeSeconds: 3600
	});
	return { next: rules, changed: true };
}

type CorsBucket = {
	info: { corsRules: readonly ExplorerCorsRule[]; revision: number };
	update: (opts: { corsRules: ExplorerCorsRule[]; ifRevisionIs?: number }) => Promise<unknown>;
};

/**
 * Add this page origin to the bucket CORS rules when the key can writeBuckets.
 * Limited application keys typically cannot — then this is a no-op.
 */
export async function ensureExplorerCors(
	bucket: CorsBucket,
	origin: string
): Promise<'ok' | 'already' | 'skipped'> {
	if (!origin) return 'skipped';
	const { next, changed } = mergeExplorerCorsRules(bucket.info.corsRules, origin);
	if (!changed) return 'already';
	try {
		await bucket.update({ corsRules: next, ifRevisionIs: bucket.info.revision });
		return 'ok';
	} catch {
		return 'skipped';
	}
}
