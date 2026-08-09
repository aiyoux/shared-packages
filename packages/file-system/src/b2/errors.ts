/** Stable UI error codes for B2 File Explorer (never include key material). */

export class ExplorerB2Error extends Error {
	readonly code: string;
	constructor(code: string, message?: string) {
		// Never allow empty message — B2 often returns message: "" (e.g. bad_auth_token).
		super((message && message.trim()) || code);
		this.name = 'ExplorerB2Error';
		this.code = code;
	}
}

type B2LikeError = {
	message?: string;
	name?: string;
	code?: string;
	status?: number;
};

/**
 * Human-readable text for any thrown value. B2 SDK `BadAuthTokenError` often has
 * `message === ""` with a useful `code` like `bad_auth_token`.
 */
export function formatB2ErrorMessage(e: unknown): string {
	if (e instanceof ExplorerB2Error) return e.message;
	if (e instanceof Error) {
		const any = e as Error & B2LikeError;
		const parts = [
			any.message?.trim(),
			any.code && any.code !== any.message ? String(any.code) : '',
			any.name && any.name !== 'Error' && any.name !== 'ExplorerB2Error' ? any.name : ''
		].filter(Boolean);
		if (parts.length) return parts.join(' · ');
	}
	if (e && typeof e === 'object') {
		const any = e as B2LikeError;
		const parts = [any.message?.trim(), any.code, any.name].filter(Boolean);
		if (parts.length) return parts.join(' · ');
	}
	const s = String(e ?? '').trim();
	return s || 'B2 request failed';
}

export function mapB2Error(e: unknown): ExplorerB2Error {
	if (e instanceof ExplorerB2Error) return e;

	const any = (e && typeof e === 'object' ? e : {}) as B2LikeError;
	const msg = formatB2ErrorMessage(e);
	const name = e instanceof Error ? e.name : any.name || '';
	const code = typeof any.code === 'string' ? any.code : '';
	const status = typeof any.status === 'number' ? any.status : undefined;
	const lower = `${msg} ${name} ${code}`.toLowerCase();

	if (
		name.includes('Cors') ||
		lower.includes('cors') ||
		lower.includes('failed to fetch') ||
		lower.includes('networkerror')
	) {
		return new ExplorerB2Error(
			'B2_CORS',
			msg.includes('api.backblazeb2.com') || msg.includes('api0')
				? 'B2 control-plane blocked in browser. Hub must proxy via /api/b2/proxy (redeploy).'
				: `${msg} — check bucket CORS for upload/download (see docs/deploy.md).`
		);
	}

	if (
		code === 'bad_auth_token' ||
		code === 'unauthorized' ||
		name.includes('BadAuthToken') ||
		status === 401 ||
		lower.includes('auth') ||
		lower.includes('unauthorized')
	) {
		return new ExplorerB2Error(
			'B2_AUTH',
			code === 'bad_auth_token' || name.includes('BadAuthToken')
				? 'Invalid application key ID or key (bad_auth_token). Check credentials and that the key can access this bucket.'
				: msg
		);
	}

	if (
		lower.includes('forbidden') ||
		status === 403 ||
		lower.includes('access denied') ||
		code === 'access_denied'
	) {
		return new ExplorerB2Error('B2_FORBIDDEN', msg);
	}

	if (lower.includes('not found') || status === 404 || code === 'not_found') {
		return new ExplorerB2Error('B2_NOT_FOUND', msg);
	}

	if (lower.includes('network') || name === 'NetworkError') {
		return new ExplorerB2Error('B2_NETWORK', msg);
	}

	return new ExplorerB2Error('B2_ERROR', msg);
}
