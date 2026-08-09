/**
 * Browser-side rclone RC client.
 * Production: same-origin proxy paths. Tests: inject transport (simulator).
 */
import type { RcloneCallResult, RcloneTransport } from './rcloneSimulator.js';
import {
	DEFAULT_RCLONE_DOWNLOAD_PROXY_PATH,
	DEFAULT_RCLONE_RC_PROXY_PATH,
	DEFAULT_RCLONE_UPLOAD_PROXY_PATH
} from './rcAllowlist.js';
import { mapRcloneError } from './errors.js';

export type RcloneProxyPaths = {
	rc?: string;
	upload?: string;
	download?: string;
};

export type CreateRcClientOptions = {
	/** RC Basic credentials (from IDB profile — never log). */
	rcUser: string;
	rcPass: string;
	/** Upstream base URL stored on profile (loopback); sent to proxy for SSRF check. */
	baseUrl: string;
	proxyPaths?: RcloneProxyPaths;
	/** Inject full transport (simulator) — skips proxy. */
	transport?: RcloneTransport;
	fetchImpl?: typeof fetch;
};

function basicAuthHeader(user: string, pass: string): string {
	// btoa for browser; Buffer for node tests
	const token =
		typeof btoa === 'function'
			? btoa(`${user}:${pass}`)
			: Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
	return `Basic ${token}`;
}

/**
 * Create an RC transport. When `transport` is provided (tests), it is returned as-is.
 * Otherwise calls same-origin proxies with Authorization + target baseUrl.
 */
export function createRcClient(opts: CreateRcClientOptions): RcloneTransport {
	if (opts.transport) return opts.transport;

	const fetchFn = opts.fetchImpl ?? fetch;
	const rcPath = opts.proxyPaths?.rc ?? DEFAULT_RCLONE_RC_PROXY_PATH;
	const uploadPath = opts.proxyPaths?.upload ?? DEFAULT_RCLONE_UPLOAD_PROXY_PATH;
	const downloadPath = opts.proxyPaths?.download ?? DEFAULT_RCLONE_DOWNLOAD_PROXY_PATH;
	const auth = basicAuthHeader(opts.rcUser, opts.rcPass);

	return {
		async call(method: string, params: Record<string, unknown> = {}) {
			try {
				const res = await fetchFn(rcPath, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: auth
					},
					body: JSON.stringify({
						target: opts.baseUrl,
						method,
						params
					})
				});
				if (!res.ok) {
					const text = await res.text().catch(() => '');
					const err = new Error(text || res.statusText) as Error & { status: number };
					err.status = res.status;
					throw err;
				}
				return (await res.json()) as RcloneCallResult;
			} catch (e) {
				throw mapRcloneError(e);
			}
		},

		async upload(uploadOpts) {
			try {
				if (uploadOpts.signal?.aborted) {
					const e = new Error('aborted');
					(e as Error & { name: string }).name = 'AbortError';
					throw e;
				}
				const form = new FormData();
				form.set('target', opts.baseUrl);
				form.set('fs', uploadOpts.fs);
				form.set('remote', uploadOpts.remote);
				const blob =
					uploadOpts.body instanceof Blob
						? uploadOpts.body
						: new Blob([
								uploadOpts.body instanceof ArrayBuffer
									? new Uint8Array(uploadOpts.body)
									: uploadOpts.body
							]);
				form.set('file', blob, 'upload.bin');
				const res = await fetchFn(uploadPath, {
					method: 'POST',
					headers: { Authorization: auth },
					body: form,
					signal: uploadOpts.signal
				});
				uploadOpts.onProgress?.(1);
				if (!res.ok) {
					const text = await res.text().catch(() => '');
					const err = new Error(text || res.statusText) as Error & { status: number };
					err.status = res.status;
					throw err;
				}
				const ct = res.headers.get('content-type') || '';
				if (ct.includes('application/json')) {
					return (await res.json()) as RcloneCallResult;
				}
				return {};
			} catch (e) {
				throw mapRcloneError(e);
			}
		},

		async download(downloadOpts) {
			try {
				const q = new URLSearchParams({
					target: opts.baseUrl,
					fs: downloadOpts.fs,
					remote: downloadOpts.remote
				});
				const res = await fetchFn(`${downloadPath}?${q}`, {
					method: 'GET',
					headers: { Authorization: auth },
					signal: downloadOpts.signal
				});
				if (!res.ok) {
					const text = await res.text().catch(() => '');
					const err = new Error(text || res.statusText) as Error & { status: number };
					err.status = res.status;
					throw err;
				}
				return await res.blob();
			} catch (e) {
				throw mapRcloneError(e);
			}
		}
	};
}
