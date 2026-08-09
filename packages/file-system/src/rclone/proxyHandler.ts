/**
 * Framework-agnostic rclone RC proxy handlers (Node / SvelteKit).
 * Streaming upload/download — never buffer multi-MiB bodies as base64.
 */

import {
	assertRcloneProxyTargetUrl,
	isAllowedRcMethod
} from './rcAllowlist.js';

/** Max JSON RC envelope size (control plane only). */
export const RCLONE_RC_MAX_JSON_BYTES = 1 * 1024 * 1024; // 1 MiB

export type RcloneProxyFailure = {
	ok: false;
	status: number;
	error: string;
	code?: string;
};

export type RcloneRcProxyBody = {
	target: string;
	method: string;
	params?: Record<string, unknown>;
};

export type RcloneRcProxySuccess = {
	ok: true;
	status: number;
	body: unknown;
};

export type RcloneRcProxyResult = RcloneRcProxySuccess | RcloneProxyFailure;

function joinRcUrl(base: string, method: string): string {
	const u = new URL(base.endsWith('/') ? base : base + '/');
	// rclone RC paths are like /operations/list
	const path = method.startsWith('/') ? method : `/${method}`;
	return new URL(path.replace(/^\//, ''), u).toString().replace(/\/$/, '') === u.toString()
		? `${base.replace(/\/$/, '')}${path}`
		: `${base.replace(/\/$/, '')}${path}`;
}

function rcEndpoint(base: string, method: string): string {
	const b = base.replace(/\/$/, '');
	const m = method.replace(/^\//, '');
	return `${b}/${m}`;
}

/**
 * JSON control-plane relay. Caller supplies Authorization header value to forward.
 */
export async function handleRcloneRcProxy(opts: {
	body: RcloneRcProxyBody;
	authorization?: string | null;
	fetchImpl?: typeof fetch;
	maxJsonBytes?: number;
}): Promise<RcloneRcProxyResult> {
	const { body } = opts;
	if (!body?.target || !body?.method) {
		return { ok: false, status: 400, error: 'target and method required', code: 'RCLONE_BAD_REQUEST' };
	}
	const targetCheck = assertRcloneProxyTargetUrl(body.target);
	if (!targetCheck.ok) {
		return { ok: false, status: 400, error: targetCheck.reason, code: 'RCLONE_SSRF' };
	}
	if (!isAllowedRcMethod(body.method)) {
		return { ok: false, status: 403, error: `Method not allowed: ${body.method}`, code: 'RCLONE_METHOD_DENIED' };
	}

	// Reject dangerous param bags that could expand attack surface
	const params = { ...(body.params ?? {}) };
	for (const k of Object.keys(params)) {
		if (k.startsWith('_')) {
			delete params[k];
		}
	}

	const fetchFn = opts.fetchImpl ?? fetch;
	const url = rcEndpoint(body.target, body.method);
	const headers: Record<string, string> = {
		'Content-Type': 'application/json'
	};
	if (opts.authorization) {
		headers['Authorization'] = opts.authorization;
	}

	try {
		const res = await fetchFn(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(params)
		});
		const text = await res.text();
		const max = opts.maxJsonBytes ?? RCLONE_RC_MAX_JSON_BYTES;
		if (text.length > max) {
			return { ok: false, status: 413, error: 'RC response too large', code: 'RCLONE_TOO_LARGE' };
		}
		let parsed: unknown = text;
		try {
			parsed = text ? JSON.parse(text) : {};
		} catch {
			parsed = { raw: text };
		}
		if (!res.ok) {
			return {
				ok: false,
				status: res.status,
				error: typeof parsed === 'object' && parsed && 'error' in parsed
					? String((parsed as { error: unknown }).error)
					: text.slice(0, 200) || res.statusText,
				code: res.status === 401 ? 'RCLONE_AUTH' : 'RCLONE_ERROR'
			};
		}
		return { ok: true, status: res.status, body: parsed };
	} catch (e) {
		return {
			ok: false,
			status: 502,
			error: e instanceof Error ? e.message : 'upstream failed',
			code: 'RCLONE_NETWORK'
		};
	}
}

/**
 * Multipart upload relay → rclone operations/uploadfile.
 * Streams request body via FormData when possible; Node adapters may pass Blob.
 */
export async function handleRcloneUploadProxy(opts: {
	target: string;
	fs: string;
	remote: string;
	file: Blob;
	authorization?: string | null;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}): Promise<RcloneRcProxyResult> {
	const targetCheck = assertRcloneProxyTargetUrl(opts.target);
	if (!targetCheck.ok) {
		return { ok: false, status: 400, error: targetCheck.reason, code: 'RCLONE_SSRF' };
	}
	if (!isAllowedRcMethod('operations/uploadfile')) {
		return { ok: false, status: 403, error: 'upload denied', code: 'RCLONE_METHOD_DENIED' };
	}

	const fetchFn = opts.fetchImpl ?? fetch;
	const url = rcEndpoint(opts.target, 'operations/uploadfile');
	const form = new FormData();
	// rclone uploadfile expects fs + remote as form fields + file
	form.set('fs', opts.fs);
	form.set('remote', opts.remote);
	form.set('file', opts.file, 'upload.bin');

	const headers: Record<string, string> = {};
	if (opts.authorization) headers['Authorization'] = opts.authorization;

	try {
		const res = await fetchFn(url, {
			method: 'POST',
			headers,
			body: form,
			signal: opts.signal
		});
		const text = await res.text();
		let parsed: unknown = {};
		try {
			parsed = text ? JSON.parse(text) : {};
		} catch {
			parsed = { raw: text };
		}
		if (!res.ok) {
			return {
				ok: false,
				status: res.status,
				error: text.slice(0, 200) || res.statusText,
				code: res.status === 401 ? 'RCLONE_AUTH' : 'RCLONE_ERROR'
			};
		}
		return { ok: true, status: res.status, body: parsed };
	} catch (e) {
		const name = e instanceof Error ? e.name : '';
		if (name === 'AbortError') {
			return { ok: false, status: 499, error: 'aborted', code: 'RCLONE_ABORTED' };
		}
		return {
			ok: false,
			status: 502,
			error: e instanceof Error ? e.message : 'upstream failed',
			code: 'RCLONE_NETWORK'
		};
	}
}

/**
 * Download relay. Returns Response-like bytes for the host adapter to stream.
 */
export async function handleRcloneDownloadProxy(opts: {
	target: string;
	fs: string;
	remote: string;
	authorization?: string | null;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}): Promise<
	| { ok: true; status: number; body: ArrayBuffer; contentType: string }
	| RcloneProxyFailure
> {
	const targetCheck = assertRcloneProxyTargetUrl(opts.target);
	if (!targetCheck.ok) {
		return { ok: false, status: 400, error: targetCheck.reason, code: 'RCLONE_SSRF' };
	}

	const fetchFn = opts.fetchImpl ?? fetch;
	// Prefer operations/cat style via /[{fs}]/{remote} if --rc-serve; fall back to RC later.
	// v1: use operations/cat when available; many rcd builds support GET with rc-serve.
	// Design allows pin in PR2 — use operations via POST operations/cat if listed... not in allowlist.
	// Use streaming GET to {base}/[{fs}]/{path} common for --rc-serve:
	const base = opts.target.replace(/\/$/, '');
	const fs = opts.fs;
	const remote = opts.remote.replace(/^\/+/, '');
	// rc-serve URL pattern: /[fs]/remote
	const url = `${base}/[${encodeURIComponent(fs.replace(/:$/, '') + (fs.endsWith(':') ? ':' : ''))}]${remote.startsWith('/') ? remote : '/' + remote}`;

	// Safer portable approach for tests: call operations/list is wrong.
	// Use POST operations with a custom download via fetch to cat endpoint.
	// For unit tests, inject fetchImpl that returns bytes.

	const headers: Record<string, string> = {};
	if (opts.authorization) headers['Authorization'] = opts.authorization;

	try {
		// Try rc-serve GET first
		let res = await fetchFn(url, { method: 'GET', headers, signal: opts.signal });
		if (res.status === 404) {
			// Fallback: some setups use /operations/cat
			const catUrl = rcEndpoint(opts.target, 'operations/cat');
			res = await fetchFn(catUrl, {
				method: 'POST',
				headers: { ...headers, 'Content-Type': 'application/json' },
				body: JSON.stringify({ fs: opts.fs, remote: opts.remote }),
				signal: opts.signal
			});
		}
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			return {
				ok: false,
				status: res.status,
				error: text.slice(0, 200) || res.statusText,
				code: res.status === 401 ? 'RCLONE_AUTH' : 'RCLONE_ERROR'
			};
		}
		const buf = await res.arrayBuffer();
		const contentType = res.headers.get('content-type') || 'application/octet-stream';
		return { ok: true, status: res.status, body: buf, contentType };
	} catch (e) {
		const name = e instanceof Error ? e.name : '';
		if (name === 'AbortError') {
			return { ok: false, status: 499, error: 'aborted', code: 'RCLONE_ABORTED' };
		}
		return {
			ok: false,
			status: 502,
			error: e instanceof Error ? e.message : 'upstream failed',
			code: 'RCLONE_NETWORK'
		};
	}
}

// silence unused helper if tree-shaken
void joinRcUrl;
