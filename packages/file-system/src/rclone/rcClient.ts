/**
 * Browser-side rclone RC client — talks **directly** to the profile base URL.
 * No hub/Worker proxy. rcd must allow CORS from the Scratch Pad origin.
 *
 * Tests: inject `transport` (simulator) to skip network.
 */
import type { RcloneCallResult, RcloneTransport } from './rcloneSimulator.js';
import { mapRcloneError } from './errors.js';
import { xhrPostForm } from '../uploadProgress.js';

/** @deprecated Proxy paths unused in direct mode; kept for API compatibility. */
export type RcloneProxyPaths = {
	rc?: string;
	upload?: string;
	download?: string;
};

export type CreateRcClientOptions = {
	/** RC Basic credentials (from IDB profile — never log). */
	rcUser: string;
	rcPass: string;
	/** Upstream RC base URL from settings (any http(s) host the browser can reach). */
	baseUrl: string;
	/** Ignored — direct mode only. */
	proxyPaths?: RcloneProxyPaths;
	/** Inject full transport (simulator) — skips network. */
	transport?: RcloneTransport;
	fetchImpl?: typeof fetch;
};

function basicAuthHeader(user: string, pass: string): string {
	const token =
		typeof btoa === 'function'
			? btoa(`${user}:${pass}`)
			: Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
	return `Basic ${token}`;
}

function rcEndpoint(base: string, method: string): string {
	const b = base.replace(/\/$/, '');
	const m = method.replace(/^\//, '');
	return `${b}/${m}`;
}

/**
 * Create an RC transport. When `transport` is provided (tests), it is returned as-is.
 * Otherwise POSTs/GETs go straight to `baseUrl`.
 */
export function createRcClient(opts: CreateRcClientOptions): RcloneTransport {
	if (opts.transport) return opts.transport;

	const fetchFn = opts.fetchImpl ?? fetch;
	const base = opts.baseUrl.replace(/\/$/, '');
	const auth = basicAuthHeader(opts.rcUser, opts.rcPass);

	return {
		async call(method: string, params: Record<string, unknown> = {}) {
			try {
				const res = await fetchFn(rcEndpoint(base, method), {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: auth
					},
					body: JSON.stringify(params)
				});
				if (!res.ok) {
					const text = await res.text().catch(() => '');
					const err = new Error(text || res.statusText) as Error & { status: number };
					err.status = res.status;
					throw err;
				}
				return (await res.json()) as RcloneCallResult;
			} catch (e) {
				if (e instanceof TypeError) {
					throw mapRcloneError(
						new Error(
							`Cannot reach rclone at ${base} (network/CORS). Is rcd running and allowing this origin?`
						)
					);
				}
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
				form.set('fs', uploadOpts.fs);
				form.set('remote', uploadOpts.remote);
				const blob =
					uploadOpts.body instanceof Blob
						? uploadOpts.body
						: new Blob([
								uploadOpts.body instanceof ArrayBuffer
									? new Uint8Array(uploadOpts.body)
									: uploadOpts.body
							] as BlobPart[]);
				form.set('file', blob, 'upload.bin');
				const url = rcEndpoint(base, 'operations/uploadfile');
				let res: {
					ok: boolean;
					status: number;
					statusText: string;
					text: () => Promise<string>;
					json: () => Promise<unknown>;
					headers: { get(name: string): string | null };
				};
				if (uploadOpts.onProgress && typeof XMLHttpRequest !== 'undefined') {
					res = await xhrPostForm({
						url,
						form,
						headers: { Authorization: auth },
						signal: uploadOpts.signal,
						onProgress: uploadOpts.onProgress
					});
				} else {
					res = await fetchFn(url, {
						method: 'POST',
						headers: { Authorization: auth },
						body: form,
						signal: uploadOpts.signal
					});
					uploadOpts.onProgress?.(1);
				}
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
				if (e instanceof TypeError) {
					throw mapRcloneError(
						new Error(
							`Cannot reach rclone at ${base} (network/CORS). Is rcd running and allowing this origin?`
						)
					);
				}
				throw mapRcloneError(e);
			}
		},

		async download(downloadOpts) {
			try {
				// Prefer rc-serve GET; fall back to operations/cat
				const fs = downloadOpts.fs;
				const remote = downloadOpts.remote.replace(/^\/+/, '');
				const serveUrl = `${base}/[${encodeURIComponent(fs.replace(/:$/, '') + (fs.endsWith(':') ? ':' : ''))}]${remote.startsWith('/') ? remote : '/' + remote}`;
				const headers: Record<string, string> = { Authorization: auth };

				let res = await fetchFn(serveUrl, {
					method: 'GET',
					headers,
					signal: downloadOpts.signal
				});
				if (res.status === 404 || res.status === 405) {
					res = await fetchFn(rcEndpoint(base, 'operations/cat'), {
						method: 'POST',
						headers: {
							...headers,
							'Content-Type': 'application/json'
						},
						body: JSON.stringify({ fs, remote: downloadOpts.remote }),
						signal: downloadOpts.signal
					});
				}
				if (!res.ok) {
					const text = await res.text().catch(() => '');
					const err = new Error(text || res.statusText) as Error & { status: number };
					err.status = res.status;
					throw err;
				}
				return await res.blob();
			} catch (e) {
				if (e instanceof TypeError) {
					throw mapRcloneError(
						new Error(
							`Cannot reach rclone at ${base} (network/CORS). Is rcd running and allowing this origin?`
						)
					);
				}
				throw mapRcloneError(e);
			}
		}
	};
}
