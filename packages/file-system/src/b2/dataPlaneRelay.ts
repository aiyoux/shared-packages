/**
 * Same-origin relay for B2 data-plane hosts (upload pods / download).
 * Used when the bucket has no CORS rule for this page origin.
 */
import { isB2DataPlaneUrl } from './controlPlane.js';

export const B2_DATA_PLANE_RELAY_PATH = '/api/b2/data-plane';
export const B2_RELAY_URL_HEADER = 'x-b2-relay-url';
export const B2_RELAY_METHOD_HEADER = 'x-b2-relay-method';

const SKIP_HOP = new Set([
	'host',
	'connection',
	'cookie',
	'origin',
	'referer',
	'content-length',
	'transfer-encoding',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailers',
	'upgrade'
]);

export function assertB2DataPlaneRelayUrl(raw: string): URL {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		throw new Error('Invalid B2 data-plane URL');
	}
	if (!isB2DataPlaneUrl(u.toString())) {
		throw new Error(
			`B2 data-plane relay only allows upload/download hosts, not ${u.hostname}`
		);
	}
	return u;
}

function copyForwardHeaders(src: Headers): Headers {
	const headers = new Headers();
	src.forEach((value, key) => {
		const lk = key.toLowerCase();
		if (lk.startsWith('x-b2-relay-')) return;
		if (SKIP_HOP.has(lk)) return;
		headers.set(key, value);
	});
	return headers;
}

/**
 * Stream `body` to a B2 upload/download host. Same-origin callers send the
 * real B2 URL in {@link B2_RELAY_URL_HEADER}.
 */
export async function handleB2DataPlaneRelay(
	req: {
		url: string;
		method: string;
		headers: Headers;
		body: ReadableStream<Uint8Array> | ArrayBuffer | Blob | null;
	},
	fetchImpl: typeof fetch = fetch
): Promise<Response> {
	let target: URL;
	try {
		target = assertB2DataPlaneRelayUrl(req.url);
	} catch (e) {
		const msg = e instanceof Error ? e.message : 'Invalid target';
		return Response.json({ error: msg }, { status: 400 });
	}

	const method = (req.method || 'POST').toUpperCase();
	if (!['GET', 'HEAD', 'POST', 'PUT'].includes(method)) {
		return Response.json({ error: `Method not allowed: ${method}` }, { status: 400 });
	}

	const headers = copyForwardHeaders(req.headers);
	const init: RequestInit = {
		method,
		headers,
		body: method === 'GET' || method === 'HEAD' ? undefined : req.body,
		redirect: 'manual'
	};
	// Node 18+ / Workers need duplex when forwarding a streamed body.
	if (init.body && typeof ReadableStream !== 'undefined' && init.body instanceof ReadableStream) {
		(init as RequestInit & { duplex: 'half' }).duplex = 'half';
	}

	let upstream: Response;
	try {
		upstream = await fetchImpl(target.toString(), init);
	} catch (e) {
		const msg = e instanceof Error ? e.message : 'Upstream fetch failed';
		return Response.json({ error: `B2 data-plane error: ${msg}` }, { status: 502 });
	}

	const out = new Headers();
	upstream.headers.forEach((value, key) => {
		const lk = key.toLowerCase();
		if (lk === 'transfer-encoding' || lk === 'content-encoding') return;
		out.set(key, value);
	});
	return new Response(upstream.body, { status: upstream.status, headers: out });
}
