/**
 * Browser client for monitor — talks **directly** to the profile base URL
 * (loopback via SSH tunnel, etc.). No hub/Worker proxy: a Cloudflare Worker
 * cannot reach the user's loopback, so the request has to come from the page.
 *
 * Monitor must allow CORS from the Scratch Pad origin. Requests to loopback are
 * additionally annotated for Local Network Access — see `./localNetwork`.
 */
import { withLocalAddressSpace } from './localNetwork';

export type MonitorListEntry = {
	name: string;
	path: string;
	kind: 'folder' | 'file' | string;
	size?: number;
	mtime_ms?: number;
};

export type MonitorListResult = {
	path: string;
	entries: MonitorListEntry[];
	truncated: boolean;
};

export type MonitorStatResult = {
	name: string;
	path: string;
	kind: 'folder' | 'file' | string;
	size?: number;
	mtime_ms?: number;
};

export type MonitorWatchedRoot = {
	root_id: string;
	path: string;
	recursive?: boolean;
};

/** Body for `POST /v1/watch/subs`. */
export type MonitorSubsRequest = {
	/** From the stream's `watch.hello` frame. */
	clientId: string;
	subscribe?: Array<{ rootId: string; include?: string[] }>;
	/** Root ids to drop. Applied before `subscribe`, so a swap fits in one call. */
	unsubscribe?: string[];
};

export type MonitorSubsResult = {
	subscribed: Array<{ root_id: string; sub_id: string; path: string }>;
	unsubscribed: Array<{ root_id: string; sub_id: string }>;
};

export type MonitorTransport = {
	list(path: string): Promise<MonitorListResult>;
	stat(path: string): Promise<MonitorStatResult>;
	download(path: string): Promise<Blob>;
	health(): Promise<unknown>;
	/** Idempotent POST /v1/watch/roots */
	watchAddRoot(path: string, recursive?: boolean): Promise<MonitorWatchedRoot>;
	watchListRoots(): Promise<{ roots: MonitorWatchedRoot[] }>;
	/**
	 * POST /v1/watch/subs — change what an open stream watches without
	 * reconnecting it, so navigating does not resync the folders you kept.
	 */
	watchUpdateSubs(req: MonitorSubsRequest): Promise<MonitorSubsResult>;
	/** HTTP base URL (also used for the SSE watch stream). */
	baseUrl: string;
};

function joinUrl(base: string, path: string): string {
	const b = base.replace(/\/$/, '');
	const p = path.startsWith('/') ? path : `/${path}`;
	return `${b}${p}`;
}

export function createMonitorClient(opts: {
	baseUrl: string;
	fetchImpl?: typeof fetch;
}): MonitorTransport {
	const base = opts.baseUrl.replace(/\/$/, '');
	const fetchFn = opts.fetchImpl ?? fetch;

	async function getJson(pathWithQuery: string): Promise<unknown> {
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), 12_000);
		const url = joinUrl(base, pathWithQuery);
		try {
			const res = await fetchFn(url, withLocalAddressSpace(url, {
				method: 'GET',
				signal: ac.signal
			}));
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				const err =
					(body as { error?: { message?: string } | string }).error;
				const msg =
					typeof err === 'string'
						? err
						: err && typeof err === 'object' && 'message' in err
							? String(err.message)
							: res.statusText;
				throw new Error(msg || `Monitor GET failed (${res.status})`);
			}
			return body;
		} catch (e) {
			if (e instanceof Error && e.name === 'AbortError') {
				throw new Error('Monitor request timed out');
			}
			// Failed to fetch often means CORS or offline
			if (e instanceof TypeError) {
				throw new Error(
					`Cannot reach monitor at ${base} (network/CORS). Is it running and allowing this origin?`
				);
			}
			throw e;
		} finally {
			clearTimeout(t);
		}
	}

	async function postJson(path: string, body: unknown): Promise<unknown> {
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), 12_000);
		const url = joinUrl(base, path);
		try {
			const res = await fetchFn(url, withLocalAddressSpace(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				signal: ac.signal
			}));
			const parsed = await res.json().catch(() => ({}));
			if (!res.ok) {
				const err = (parsed as { error?: { message?: string; code?: string } | string }).error;
				const msg =
					typeof err === 'string'
						? err
						: err && typeof err === 'object' && 'message' in err
							? String(err.message)
							: res.statusText;
				const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
				throw new Error(code ? `[${code}] ${msg}` : (msg || `Monitor POST failed (${res.status})`));
			}
			return parsed;
		} catch (e) {
			if (e instanceof Error && e.name === 'AbortError') {
				throw new Error('Monitor request timed out');
			}
			if (e instanceof TypeError) {
				throw new Error(
					`Cannot reach monitor at ${base} (network/CORS). Is it running and allowing this origin?`
				);
			}
			throw e;
		} finally {
			clearTimeout(t);
		}
	}

	return {
		baseUrl: base,
		async list(path: string) {
			return (await getJson(
				`/v1/fs/list?path=${encodeURIComponent(path)}`
			)) as MonitorListResult;
		},
		async stat(path: string) {
			return (await getJson(
				`/v1/fs/stat?path=${encodeURIComponent(path)}`
			)) as MonitorStatResult;
		},
		async health() {
			return getJson('/v1/health');
		},
		async watchAddRoot(path: string, recursive = true) {
			return (await postJson('/v1/watch/roots', {
				path,
				recursive: recursive !== false
			})) as MonitorWatchedRoot;
		},
		async watchListRoots() {
			return (await getJson('/v1/watch/roots')) as { roots: MonitorWatchedRoot[] };
		},
		async watchUpdateSubs(req) {
			return (await postJson('/v1/watch/subs', {
				client_id: req.clientId,
				subscribe: (req.subscribe ?? []).map((s) => ({
					root_id: s.rootId,
					...(s.include ? { include: s.include } : {})
				})),
				unsubscribe: req.unsubscribe ?? []
			})) as MonitorSubsResult;
		},
		async download(path: string) {
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 60_000);
			const url = joinUrl(base, `/v1/fs/read?path=${encodeURIComponent(path)}`);
			try {
				const res = await fetchFn(
					url,
					withLocalAddressSpace(url, { method: 'GET', signal: ac.signal })
				);
				if (!res.ok) {
					const text = await res.text().catch(() => '');
					throw new Error(text || `Download failed (${res.status})`);
				}
				return res.blob();
			} catch (e) {
				if (e instanceof Error && e.name === 'AbortError') {
					throw new Error('Monitor download timed out');
				}
				if (e instanceof TypeError) {
					throw new Error(
						`Cannot reach monitor at ${base} (network/CORS). Is it running and allowing this origin?`
					);
				}
				throw e;
			} finally {
				clearTimeout(t);
			}
		}
	};
}
