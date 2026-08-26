/**
 * Byte-progress helpers for browser uploads.
 *
 * `fetch` does not expose request-body progress. Streaming the blob through a
 * duplex ReadableStream reports bytes handed to the network stack while still
 * using `fetch` (Local Network Access `targetAddressSpace` stays valid).
 * Multipart FormData (rclone) uses XHR `upload.onprogress` when present.
 */

type DuplexInit = RequestInit & { duplex?: 'half' };

export async function fetchPutBlob(args: {
	url: string;
	body: Blob;
	headers?: HeadersInit;
	signal?: AbortSignal;
	onProgress?: (sent: number, total: number) => void;
	fetchImpl: typeof fetch;
	extraInit?: RequestInit;
}): Promise<Response> {
	const total = args.body.size;
	const headers = new Headers(args.extraInit?.headers);
	if (args.headers) {
		const extra = new Headers(args.headers);
		extra.forEach((v, k) => headers.set(k, v));
	}
	const base: DuplexInit = {
		...args.extraInit,
		method: args.extraInit?.method ?? 'PUT',
		headers,
		signal: args.signal ?? args.extraInit?.signal
	};

	const send = async (init: DuplexInit): Promise<Response> => {
		const res = await args.fetchImpl(args.url, init);
		args.onProgress?.(total, total);
		return res;
	};

	// Duplex ReadableStream bodies make Chrome negotiate HTTP/2. Cleartext
	// HTTP/1.1 (local monitor) then fails with net::ERR_ALPN_NEGOTIATION_FAILED
	// and the fetch can hang at a few percent with no reject.
	const cleartextHttp = /^http:\/\//i.test(args.url);
	if (!args.onProgress || typeof args.body.stream !== 'function' || cleartextHttp) {
		base.body = args.body;
		args.onProgress?.(0, total);
		return send(base);
	}

	let sent = 0;
	args.onProgress(0, total);
	const reader = args.body.stream().getReader();
	base.body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) {
				controller.close();
				return;
			}
			sent += value.byteLength;
			args.onProgress?.(Math.min(sent, total), total);
			controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
	base.duplex = 'half';
	try {
		return await send(base);
	} catch (e) {
		base.body = args.body;
		delete base.duplex;
		try {
			return await send(base);
		} catch {
			throw e;
		}
	}
}

export type XhrPostResult = {
	ok: boolean;
	status: number;
	statusText: string;
	text: () => Promise<string>;
	json: () => Promise<unknown>;
	headers: { get(name: string): string | null };
};

function xhrPost(args: {
	url: string;
	body: Blob | FormData;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	onProgress?: (pct: number) => void;
}): Promise<XhrPostResult> {
	return new Promise((resolve, reject) => {
		if (typeof XMLHttpRequest === 'undefined') {
			reject(new Error('XMLHttpRequest is not available'));
			return;
		}
		const xhr = new XMLHttpRequest();
		xhr.open('POST', args.url);
		for (const [k, v] of Object.entries(args.headers ?? {})) {
			xhr.setRequestHeader(k, v);
		}
		const onAbort = () => {
			xhr.abort();
		};
		args.signal?.addEventListener('abort', onAbort);
		xhr.upload.onprogress = (ev) => {
			if (!args.onProgress) return;
			if (ev.lengthComputable && ev.total > 0) {
				args.onProgress(Math.min(1, ev.loaded / ev.total));
			}
		};
		xhr.onload = () => {
			args.signal?.removeEventListener('abort', onAbort);
			args.onProgress?.(1);
			resolve({
				ok: xhr.status >= 200 && xhr.status < 300,
				status: xhr.status,
				statusText: xhr.statusText,
				text: async () => String(xhr.responseText ?? ''),
				json: async () => JSON.parse(String(xhr.responseText || '{}')),
				headers: { get: (name) => xhr.getResponseHeader(name) }
			});
		};
		xhr.onerror = () => {
			args.signal?.removeEventListener('abort', onAbort);
			reject(new TypeError('Network error'));
		};
		xhr.onabort = () => {
			args.signal?.removeEventListener('abort', onAbort);
			const e = new Error('aborted');
			e.name = 'AbortError';
			reject(e);
		};
		xhr.send(args.body);
	});
}

export function xhrPostForm(args: {
	url: string;
	form: FormData;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	onProgress?: (pct: number) => void;
}): Promise<XhrPostResult> {
	return xhrPost({ ...args, body: args.form });
}

/** POST a Blob (B2 `b2_upload_file`) with `xhr.upload.onprogress`. */
export function xhrPostBlob(args: {
	url: string;
	body: Blob;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	onProgress?: (pct: number) => void;
}): Promise<XhrPostResult> {
	return xhrPost(args);
}
