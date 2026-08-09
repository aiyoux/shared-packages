/** Stable UI error codes for rclone File Explorer (never include RC secrets). */

export class ExplorerRcloneError extends Error {
	readonly code: string;
	constructor(code: string, message?: string) {
		super((message && message.trim()) || code);
		this.name = 'ExplorerRcloneError';
		this.code = code;
	}
}

type RcloneLikeError = {
	message?: string;
	name?: string;
	code?: string | number;
	status?: number;
	statusText?: string;
};

const SECRET_PATTERNS = [
	/authorization\s*[:=]\s*\S+/gi,
	/basic\s+[a-z0-9+/=]+/gi,
	/rcpass\s*[:=]\s*\S+/gi,
	/password\s*[:=]\s*\S+/gi
];

/** Strip anything that looks like credentials from a message. */
export function scrubSecrets(msg: string): string {
	let s = msg;
	for (const re of SECRET_PATTERNS) {
		s = s.replace(re, '[redacted]');
	}
	return s;
}

/**
 * Human-readable text for any thrown value — never empty, never raw secrets.
 */
export function formatRcloneErrorMessage(e: unknown): string {
	if (e instanceof ExplorerRcloneError) return scrubSecrets(e.message);
	if (e instanceof Error) {
		const any = e as Error & RcloneLikeError;
		const parts = [
			any.message?.trim(),
			any.code != null && String(any.code) !== any.message ? String(any.code) : '',
			any.name && any.name !== 'Error' && any.name !== 'ExplorerRcloneError' ? any.name : ''
		].filter(Boolean);
		if (parts.length) return scrubSecrets(parts.join(' · '));
	}
	if (e && typeof e === 'object') {
		const any = e as RcloneLikeError;
		const parts = [any.message?.trim(), any.code != null ? String(any.code) : '', any.name].filter(
			Boolean
		);
		if (parts.length) return scrubSecrets(parts.join(' · '));
	}
	const s = String(e ?? '').trim();
	return scrubSecrets(s || 'rclone request failed');
}

export function mapRcloneError(e: unknown): ExplorerRcloneError {
	if (e instanceof ExplorerRcloneError) return e;

	const any = (e && typeof e === 'object' ? e : {}) as RcloneLikeError;
	const msg = formatRcloneErrorMessage(e);
	const name = e instanceof Error ? e.name : any.name || '';
	const code = any.code != null ? String(any.code) : '';
	const status = typeof any.status === 'number' ? any.status : undefined;
	const lower = `${msg} ${name} ${code}`.toLowerCase();

	if (status === 401 || lower.includes('unauthorized') || lower.includes('auth')) {
		return new ExplorerRcloneError(
			'RCLONE_AUTH',
			'Invalid RC username or password (unauthorized). Check profile credentials.'
		);
	}

	if (status === 403 || lower.includes('forbidden') || lower.includes('access denied')) {
		return new ExplorerRcloneError('RCLONE_FORBIDDEN', msg);
	}

	if (status === 404 || lower.includes('not found') || code === 'not_found') {
		return new ExplorerRcloneError('RCLONE_NOT_FOUND', msg);
	}

	if (status === 429 || lower.includes('rate limit') || lower.includes('too many')) {
		return new ExplorerRcloneError('RCLONE_RATE_LIMIT', msg);
	}

	if (
		name.includes('Abort') ||
		lower.includes('aborted') ||
		lower.includes('aborterror') ||
		code === 'ABORT_ERR'
	) {
		return new ExplorerRcloneError('RCLONE_ABORTED', msg || 'Upload/download aborted');
	}

	if (
		lower.includes('failed to fetch') ||
		lower.includes('networkerror') ||
		lower.includes('network') ||
		name === 'NetworkError' ||
		name === 'TypeError'
	) {
		return new ExplorerRcloneError('RCLONE_NETWORK', msg);
	}

	return new ExplorerRcloneError('RCLONE_ERROR', msg);
}
