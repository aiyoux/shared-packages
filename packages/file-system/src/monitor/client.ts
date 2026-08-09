/**
 * Browser client for monitor via same-origin hub proxy (avoids CORS + SSRF guard).
 */

export type MonitorProxyPaths = {
	/** JSON control plane (list/stat/health) */
	api: string;
	/** File download stream */
	download: string;
};

export const DEFAULT_MONITOR_PROXY_PATHS: MonitorProxyPaths = {
	api: '/api/monitor/api',
	download: '/api/monitor/download'
};

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

export type MonitorTransport = {
	list(path: string): Promise<MonitorListResult>;
	stat(path: string): Promise<MonitorStatResult>;
	download(path: string): Promise<Blob>;
	health(): Promise<unknown>;
	/** Idempotent POST /v1/watch/roots via hub proxy */
	watchAddRoot(path: string, recursive?: boolean): Promise<MonitorWatchedRoot>;
	watchListRoots(): Promise<{ roots: MonitorWatchedRoot[] }>;
	/** HTTP base URL for direct WebSocket (loopback). */
	baseUrl: string;
};

export function createMonitorClient(opts: {
	baseUrl: string;
	proxyPaths?: MonitorProxyPaths;
	fetchImpl?: typeof fetch;
}): MonitorTransport {
	const base = opts.baseUrl.replace(/\/$/, '');
	const paths = opts.proxyPaths ?? DEFAULT_MONITOR_PROXY_PATHS;
	const fetchFn = opts.fetchImpl ?? fetch;

	async function apiCall(
		op: string,
		extra?: { path?: string; recursive?: boolean }
	): Promise<unknown> {
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), 12_000);
		try {
			const res = await fetchFn(paths.api, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ target: base, op, ...extra }),
				signal: ac.signal
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				const err = (body as { error?: string; code?: string }).error || res.statusText;
				throw new Error(err || `Monitor ${op} failed (${res.status})`);
			}
			return body;
		} catch (e) {
			if (e instanceof Error && e.name === 'AbortError') {
				throw new Error(`Monitor ${op} timed out`);
			}
			throw e;
		} finally {
			clearTimeout(t);
		}
	}

	return {
		baseUrl: base,
		async list(path: string) {
			return (await apiCall('list', { path })) as MonitorListResult;
		},
		async stat(path: string) {
			return (await apiCall('stat', { path })) as MonitorStatResult;
		},
		async health() {
			return apiCall('health');
		},
		async watchAddRoot(path: string, recursive = true) {
			return (await apiCall('watch_add_root', { path, recursive })) as MonitorWatchedRoot;
		},
		async watchListRoots() {
			return (await apiCall('watch_list_roots')) as { roots: MonitorWatchedRoot[] };
		},
		async download(path: string) {
			const q = new URLSearchParams({ target: base, path });
			const res = await fetchFn(`${paths.download}?${q}`);
			if (!res.ok) {
				const t = await res.text().catch(() => '');
				throw new Error(t || `Download failed (${res.status})`);
			}
			return res.blob();
		}
	};
}
