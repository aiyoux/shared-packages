/**
 * Monitor collab HTTP/SSE client. PNA requires `fetch` (`openJsonSse` /
 * `withLocalAddressSpace`).
 *
 * This is the transport only. `createMonitorCollabSession` is `./collabSession.ts`.
 */
import { openJsonSse } from './sse.js';
import { withLocalAddressSpace } from './localNetwork.js';

export type CollabHttpOptions = {
	baseUrl: string;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
};

export type CollabSnapshot = {
	seq: number;
	page: unknown;
};

export class CollabConflictError extends Error {
	readonly status = 409 as const;
	readonly headSeq: number;
	constructor(headSeq: number, message = `collab conflict (head_seq=${headSeq})`) {
		super(message);
		this.name = 'CollabConflictError';
		this.headSeq = headSeq;
	}
}

function joinUrl(base: string, path: string): string {
	const b = base.replace(/\/$/, '');
	const p = path.startsWith('/') ? path : `/${path}`;
	return `${b}${p}`;
}

function collabInit(url: string, init: RequestInit): RequestInit {
	return withLocalAddressSpace(url, init);
}

function readHeadSeq(body: unknown): number | null {
	if (!body || typeof body !== 'object') return null;
	const o = body as Record<string, unknown>;
	const n = o.head_seq ?? o.headSeq;
	if (typeof n === 'number' && Number.isFinite(n)) return n;
	if (typeof n === 'string' && n.trim() && Number.isFinite(Number(n))) return Number(n);
	return null;
}

async function parseJson(res: Response): Promise<unknown> {
	const text = await res.text();
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
}

async function postJson(
	opts: CollabHttpOptions,
	path: string,
	body: unknown
): Promise<{ status: number; body: unknown }> {
	const fetchFn = opts.fetchImpl ?? fetch;
	const url = joinUrl(opts.baseUrl, path);
	const res = await fetchFn(
		url,
		collabInit(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal: opts.signal
		})
	);
	const parsed = await parseJson(res);
	if (res.status === 409) {
		const headSeq = readHeadSeq(parsed);
		throw new CollabConflictError(headSeq ?? -1);
	}
	if (!res.ok) {
		const err = (parsed as { error?: { message?: string; code?: string } | string }).error;
		const msg =
			typeof err === 'string'
				? err
				: err && typeof err === 'object' && 'message' in err
					? String(err.message)
					: res.statusText;
		throw new Error(msg || `Monitor collab POST failed (${res.status})`);
	}
	return { status: res.status, body: parsed };
}

/** `GET /v1/collab/events` via fetch SSE. */
export async function subscribe(
	opts: CollabHttpOptions & {
		onEvent: (event: string, data: unknown) => void;
	}
): Promise<{ abort: () => void }> {
	const url = joinUrl(opts.baseUrl, '/v1/collab/events');
	return openJsonSse({
		url,
		fetchImpl: opts.fetchImpl,
		signal: opts.signal,
		onEvent: opts.onEvent
	});
}

/** `POST /v1/collab/subs`. */
export async function postSubs(
	opts: CollabHttpOptions,
	req: {
		clientId: string;
		subscribe?: Array<{ path: string }>;
		unsubscribe?: string[];
	}
): Promise<{
	subscribed: Array<{ sub_id: string; path: string }>;
	unsubscribed: Array<{ sub_id: string; path: string }>;
}> {
	const { body } = await postJson(opts, '/v1/collab/subs', {
		client_id: req.clientId,
		subscribe: req.subscribe ?? [],
		unsubscribe: req.unsubscribe ?? []
	});
	return body as {
		subscribed: Array<{ sub_id: string; path: string }>;
		unsubscribed: Array<{ sub_id: string; path: string }>;
	};
}

/** `POST /v1/collab/ops`. 409 → {@link CollabConflictError}. */
export async function postOps(
	opts: CollabHttpOptions,
	req: { clientId: string; path: string; baseSeq: number; ops: unknown[] }
): Promise<{ seq: number }> {
	const { body } = await postJson(opts, '/v1/collab/ops', {
		client_id: req.clientId,
		path: req.path,
		base_seq: req.baseSeq,
		ops: req.ops
	});
	const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
	const seq = typeof o.seq === 'number' ? o.seq : Number(o.seq);
	if (!Number.isFinite(seq)) throw new Error('Monitor collab ops response missing seq');
	return { seq };
}

/** `POST /v1/collab/snapshot` — persist the acked prefix page. */
export async function submitPage(
	opts: CollabHttpOptions & { clientId?: string; path: string },
	seq: number,
	page: unknown
): Promise<{ seq: number }> {
	const payload: Record<string, unknown> = { path: opts.path, seq, page };
	if (opts.clientId) payload.client_id = opts.clientId;
	const { body } = await postJson(opts, '/v1/collab/snapshot', payload);
	const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
	const got = typeof o.seq === 'number' ? o.seq : seq;
	return { seq: got };
}

/** `POST /v1/collab/presence`. */
export async function postPresence(
	opts: CollabHttpOptions,
	req: { clientId: string; path: string; state: unknown }
): Promise<void> {
	await postJson(opts, '/v1/collab/presence', {
		client_id: req.clientId,
		path: req.path,
		state: req.state
	});
}

/** `GET /v1/collab/snapshot?path=` — in-memory last CAS page, not disk. */
export async function getSnapshot(
	opts: CollabHttpOptions,
	path: string
): Promise<CollabSnapshot> {
	const fetchFn = opts.fetchImpl ?? fetch;
	const url = joinUrl(opts.baseUrl, `/v1/collab/snapshot?path=${encodeURIComponent(path)}`);
	const res = await fetchFn(
		url,
		collabInit(url, {
			method: 'GET',
			signal: opts.signal
		})
	);
	const parsed = await parseJson(res);
	if (!res.ok) {
		throw new Error(`Monitor collab GET snapshot failed (${res.status})`);
	}
	const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	const seq = typeof o.seq === 'number' ? o.seq : Number(o.seq);
	if (!Number.isFinite(seq)) throw new Error('Monitor collab snapshot missing seq');
	return { seq, page: 'page' in o ? o.page : null };
}
