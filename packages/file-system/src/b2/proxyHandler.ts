/**
 * Framework-agnostic B2 control-plane proxy handler.
 *
 * Host apps mount a thin route (e.g. SvelteKit `POST /api/b2/proxy`) that
 * parses JSON and returns this result. Object upload/download bytes do **not**
 * go through this path — those stay browser ↔ B2 data-plane hosts.
 */
import { assertB2ControlPlaneUrl } from './controlPlane.js';

export const B2_PROXY_MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB — control-plane JSON only
export const B2_PROXY_ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);

export type B2ProxyRequestBody = {
	url?: string;
	method?: string;
	headers?: Record<string, string>;
	bodyBase64?: string | null;
};

export type B2ProxySuccess = {
	ok: true;
	status: number;
	headers: Record<string, string>;
	bodyBase64: string;
};

export type B2ProxyFailure = {
	ok: false;
	/** HTTP status for the *proxy* response (4xx/5xx). */
	status: number;
	error: string;
};

export type B2ProxyResult = B2ProxySuccess | B2ProxyFailure;

function bytesToBase64(bytes: Uint8Array): string {
	const chunk = 0x8000;
	let binary = '';
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/**
 * Relay a control-plane request to B2 after validating the target URL.
 */
export async function handleB2ControlPlaneProxy(
	payload: B2ProxyRequestBody,
	fetchImpl: typeof fetch = fetch
): Promise<B2ProxyResult> {
	if (!payload.url || typeof payload.url !== 'string') {
		return { ok: false, status: 400, error: 'Missing url' };
	}

	let target: URL;
	try {
		target = assertB2ControlPlaneUrl(payload.url);
	} catch (e) {
		return {
			ok: false,
			status: 400,
			error: e instanceof Error ? e.message : 'Invalid target URL'
		};
	}

	const method = (payload.method || 'GET').toUpperCase();
	if (!B2_PROXY_ALLOWED_METHODS.has(method)) {
		return { ok: false, status: 400, error: `Method not allowed: ${method}` };
	}

	const headers = new Headers();
	if (payload.headers && typeof payload.headers === 'object') {
		for (const [k, v] of Object.entries(payload.headers)) {
			if (typeof v !== 'string') continue;
			const lk = k.toLowerCase();
			if (
				lk === 'host' ||
				lk === 'connection' ||
				lk === 'content-length' ||
				lk === 'transfer-encoding' ||
				lk === 'cookie'
			) {
				continue;
			}
			headers.set(k, v);
		}
	}

	let body: ArrayBuffer | undefined;
	if (payload.bodyBase64) {
		let bytes: Uint8Array;
		try {
			bytes = base64ToBytes(payload.bodyBase64);
		} catch {
			return { ok: false, status: 400, error: 'Invalid bodyBase64' };
		}
		if (bytes.byteLength > B2_PROXY_MAX_BODY_BYTES) {
			return {
				ok: false,
				status: 413,
				error: 'Request body too large for control-plane proxy'
			};
		}
		body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	}

	let upstream: Response;
	try {
		upstream = await fetchImpl(target.toString(), {
			method,
			headers,
			body: method === 'GET' || method === 'HEAD' ? undefined : body,
			redirect: 'manual'
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : 'Upstream fetch failed';
		return { ok: false, status: 502, error: `B2 upstream error: ${msg}` };
	}

	const respBuf = await upstream.arrayBuffer();
	if (respBuf.byteLength > B2_PROXY_MAX_BODY_BYTES) {
		return { ok: false, status: 502, error: 'B2 control-plane response too large' };
	}

	const outHeaders: Record<string, string> = {};
	upstream.headers.forEach((value, key) => {
		const lk = key.toLowerCase();
		if (lk === 'transfer-encoding' || lk === 'content-encoding' || lk === 'content-length') {
			return;
		}
		outHeaders[key] = value;
	});

	return {
		ok: true,
		status: upstream.status,
		headers: outHeaders,
		bodyBase64: bytesToBase64(new Uint8Array(respBuf))
	};
}
