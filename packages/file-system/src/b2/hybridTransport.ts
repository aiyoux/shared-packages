/**
 * Hybrid B2 HttpTransport:
 * - Control plane (api*.backblazeb2.com) → same-origin proxy path (default `/api/b2/proxy`)
 * - Data plane (upload pods + download hosts) → browser `fetch` direct to B2
 *
 * Object bytes never pass through the Worker.
 */
import type { HttpRequest, HttpResponse, HttpTransport } from '@backblaze-labs/b2-sdk';
import { isB2ControlPlaneUrl, isB2DataPlaneUrl } from './controlPlane.js';

/** Default same-origin control-plane relay path used by host apps. */
export const DEFAULT_B2_PROXY_PATH = '/api/b2/proxy';

export type HybridB2TransportOptions = {
	/**
	 * Absolute or origin-relative URL for the control-plane proxy.
	 * Defaults to {@link DEFAULT_B2_PROXY_PATH}.
	 */
	proxyPath?: string;
};

/** Headers that must not be re-sent from browser to our proxy as hop-by-hop noise. */
const SKIP_FORWARD_HEADERS = new Set([
	'host',
	'connection',
	'content-length',
	'transfer-encoding',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailers',
	'upgrade',
	'cookie',
	// Browser may inject; B2 does not need our UA via proxy envelope
	'origin',
	'referer'
]);

function createHttpResponse(status: number, headers: Headers, bodyBytes: ArrayBuffer): HttpResponse {
	const body =
		bodyBytes.byteLength === 0
			? null
			: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(bodyBytes));
						controller.close();
					}
				});

	let consumed = false;
	async function readOnce(): Promise<ArrayBuffer> {
		if (consumed) throw new Error('B2 hybrid transport: response body already consumed');
		consumed = true;
		return bodyBytes;
	}

	return {
		status,
		headers,
		body,
		async json<T>() {
			const text = new TextDecoder().decode(await readOnce());
			return JSON.parse(text) as T;
		},
		async text() {
			return new TextDecoder().decode(await readOnce());
		},
		async arrayBuffer() {
			return readOnce();
		}
	};
}

async function bodyToArrayBuffer(body: BodyInit | null | undefined): Promise<ArrayBuffer | null> {
	if (body == null) return null;
	if (typeof body === 'string') return new TextEncoder().encode(body).buffer;
	if (body instanceof ArrayBuffer) return body;
	if (ArrayBuffer.isView(body)) {
		const view = body as ArrayBufferView;
		return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
	}
	if (typeof Blob !== 'undefined' && body instanceof Blob) {
		return body.arrayBuffer();
	}
	if (typeof Response !== 'undefined') {
		// ReadableStream / FormData / URLSearchParams
		return new Response(body).arrayBuffer();
	}
	throw new Error('Unsupported request body type for B2 transport');
}

async function directSend(request: HttpRequest): Promise<HttpResponse> {
	if (!isB2DataPlaneUrl(request.url) && !isB2ControlPlaneUrl(request.url)) {
		// Should not happen with a healthy B2 realm; fail closed.
		throw new Error(`Refusing non-B2 URL: ${safeUrlForError(request.url)}`);
	}
	const headers = new Headers(request.headers);
	const init: RequestInit = {
		method: request.method,
		headers,
		body: request.body ?? null,
		redirect: 'manual',
		signal: request.signal
	};
	const res = await fetch(request.url, init);
	const buf = await res.arrayBuffer();
	return createHttpResponse(res.status, res.headers, buf);
}

async function proxySend(request: HttpRequest, proxyPath: string): Promise<HttpResponse> {
	const bodyBuf = await bodyToArrayBuffer(request.body ?? null);
	const forwardHeaders: Record<string, string> = {};
	if (request.headers) {
		for (const [k, v] of Object.entries(request.headers)) {
			if (SKIP_FORWARD_HEADERS.has(k.toLowerCase())) continue;
			forwardHeaders[k] = v;
		}
	}

	// Base64 body keeps binary-safe path if control plane ever posts non-UTF8
	const bodyBase64 =
		bodyBuf && bodyBuf.byteLength > 0 ? bytesToBase64(new Uint8Array(bodyBuf)) : null;

	const proxyUrl =
		proxyPath.startsWith('http://') || proxyPath.startsWith('https://')
			? proxyPath
			: typeof window !== 'undefined'
				? `${window.location.origin}${proxyPath}`
				: proxyPath;

	const res = await fetch(proxyUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({
			url: request.url,
			method: request.method,
			headers: forwardHeaders,
			bodyBase64
		}),
		signal: request.signal
	});

	const contentType = res.headers.get('content-type') || '';
	const isJson = contentType.includes('application/json');

	if (!res.ok) {
		// SvelteKit error() uses { message }; our 502 uses { error }
		if (isJson) {
			const errJson = (await res.json().catch(() => null)) as {
				error?: string;
				message?: string;
			} | null;
			const msg =
				errJson?.error || errJson?.message || `B2 proxy HTTP ${res.status}`;
			throw new Error(msg);
		}
		const text = await res.text().catch(() => '');
		throw new Error(
			`B2 proxy HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`.trim()
		);
	}

	if (!isJson) {
		throw new Error('B2 proxy returned non-JSON success body');
	}

	const envelope = (await res.json()) as {
		status?: number;
		headers?: Record<string, string>;
		bodyBase64?: string;
		error?: string;
	};

	if (typeof envelope.status !== 'number') {
		throw new Error(envelope.error || 'B2 proxy returned invalid envelope');
	}

	const outHeaders = new Headers();
	for (const [k, v] of Object.entries(envelope.headers ?? {})) {
		outHeaders.set(k, v);
	}
	const raw = envelope.bodyBase64 ? base64ToBytes(envelope.bodyBase64) : new Uint8Array();
	// Copy into a fresh ArrayBuffer so .buffer length matches the bytes
	const copy = new Uint8Array(raw.byteLength);
	copy.set(raw);
	return createHttpResponse(envelope.status, outHeaders, copy.buffer);
}

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

function safeUrlForError(url: string): string {
	try {
		const u = new URL(url);
		return `${u.protocol}//${u.host}${u.pathname}`;
	} catch {
		return '<invalid-url>';
	}
}

/**
 * Production browser transport: control-plane via same-origin proxy, bytes direct to B2.
 */
export function createHybridB2Transport(opts: HybridB2TransportOptions = {}): HttpTransport {
	const proxyPath = opts.proxyPath ?? DEFAULT_B2_PROXY_PATH;
	return {
		async send(request: HttpRequest): Promise<HttpResponse> {
			if (isB2ControlPlaneUrl(request.url)) {
				return proxySend(request, proxyPath);
			}
			return directSend(request);
		}
	};
}
