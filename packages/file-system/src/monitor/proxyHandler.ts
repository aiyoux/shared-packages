/**
 * Framework-agnostic monitor proxy (Node / SvelteKit).
 * SSRF: loopback + allowlisted ports only.
 */

import { assertMonitorProxyTargetUrl } from './types.js';

export type MonitorProxyFailure = {
	ok: false;
	status: number;
	error: string;
	code?: string;
};

export type MonitorApiBody = {
	target: string;
	op: 'list' | 'stat' | 'health' | 'meta' | 'watch_add_root' | 'watch_list_roots';
	path?: string;
	/** POST /v1/watch/roots recursive flag */
	recursive?: boolean;
};

export type MonitorApiResult =
	| { ok: true; status: number; body: unknown }
	| MonitorProxyFailure;

export async function handleMonitorApiProxy(opts: {
	body: MonitorApiBody;
	fetchImpl?: typeof fetch;
}): Promise<MonitorApiResult> {
	const { body } = opts;
	if (!body?.target || !body?.op) {
		return { ok: false, status: 400, error: 'target and op required', code: 'MONITOR_BAD_REQUEST' };
	}
	const check = assertMonitorProxyTargetUrl(body.target);
	if (!check.ok) {
		return { ok: false, status: 400, error: check.reason, code: 'MONITOR_SSRF' };
	}

	const base = body.target.replace(/\/$/, '');
	const fetchFn = opts.fetchImpl ?? fetch;

	let url: string;
	let method: 'GET' | 'POST' = 'GET';
	let postBody: string | undefined;

	switch (body.op) {
		case 'health':
			url = `${base}/v1/health`;
			break;
		case 'meta':
			url = `${base}/v1/meta`;
			break;
		case 'list':
			if (!body.path) {
				return { ok: false, status: 400, error: 'path required', code: 'MONITOR_BAD_REQUEST' };
			}
			url = `${base}/v1/fs/list?path=${encodeURIComponent(body.path)}`;
			break;
		case 'stat':
			if (!body.path) {
				return { ok: false, status: 400, error: 'path required', code: 'MONITOR_BAD_REQUEST' };
			}
			url = `${base}/v1/fs/stat?path=${encodeURIComponent(body.path)}`;
			break;
		case 'watch_list_roots':
			url = `${base}/v1/watch/roots`;
			break;
		case 'watch_add_root':
			if (!body.path) {
				return { ok: false, status: 400, error: 'path required', code: 'MONITOR_BAD_REQUEST' };
			}
			url = `${base}/v1/watch/roots`;
			method = 'POST';
			postBody = JSON.stringify({
				path: body.path,
				recursive: body.recursive !== false
			});
			break;
		default:
			return { ok: false, status: 400, error: 'unknown op', code: 'MONITOR_BAD_REQUEST' };
	}

	try {
		const res = await fetchFn(url, {
			method,
			headers: postBody ? { 'content-type': 'application/json' } : undefined,
			body: postBody
		});
		const text = await res.text();
		let parsed: unknown = text;
		try {
			parsed = text ? JSON.parse(text) : {};
		} catch {
			/* keep text */
		}
		if (!res.ok) {
			const errObj = parsed as { error?: { message?: string; code?: string } };
			return {
				ok: false,
				status: res.status,
				error: errObj?.error?.message || text || res.statusText,
				code: errObj?.error?.code || 'MONITOR_UPSTREAM'
			};
		}
		return { ok: true, status: res.status, body: parsed };
	} catch (e) {
		return {
			ok: false,
			status: 502,
			error: e instanceof Error ? e.message : String(e),
			code: 'MONITOR_UNAVAILABLE'
		};
	}
}

export async function handleMonitorDownloadProxy(opts: {
	target: string;
	path: string;
	fetchImpl?: typeof fetch;
}): Promise<
	| { ok: true; response: Response }
	| MonitorProxyFailure
> {
	const check = assertMonitorProxyTargetUrl(opts.target);
	if (!check.ok) {
		return { ok: false, status: 400, error: check.reason, code: 'MONITOR_SSRF' };
	}
	if (!opts.path?.trim()) {
		return { ok: false, status: 400, error: 'path required', code: 'MONITOR_BAD_REQUEST' };
	}
	const base = opts.target.replace(/\/$/, '');
	const url = `${base}/v1/fs/read?path=${encodeURIComponent(opts.path)}`;
	const fetchFn = opts.fetchImpl ?? fetch;
	try {
		const res = await fetchFn(url, { method: 'GET' });
		if (!res.ok) {
			const t = await res.text().catch(() => '');
			return {
				ok: false,
				status: res.status,
				error: t || res.statusText,
				code: 'MONITOR_UPSTREAM'
			};
		}
		return { ok: true, response: res };
	} catch (e) {
		return {
			ok: false,
			status: 502,
			error: e instanceof Error ? e.message : String(e),
			code: 'MONITOR_UNAVAILABLE'
		};
	}
}
