/**
 * Browser client for monitor — talks **directly** to the profile base URL
 * (loopback via SSH tunnel, etc.). No hub/Worker proxy: a Cloudflare Worker
 * cannot reach the user's loopback, so the request has to come from the page.
 *
 * Monitor must allow CORS from the Scratch Pad origin. Requests to loopback are
 * additionally annotated for Local Network Access — see `./localNetwork`.
 */
import { blobFromResponse } from '../readProgress.js';
import { withLocalAddressSpace } from './localNetwork';
import { openJsonSse } from './sse.js';

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

export type MonitorHostDisk = { name: string; used: number; total: number };

export type MonitorHostSnapshot = {
	cpu_pct: number;
	mem_used: number;
	mem_total: number;
	disks: MonitorHostDisk[];
};

export type MonitorGitLogEntry = {
	sha: string;
	subject: string;
	author?: string;
	committed_at?: string;
};

export type MonitorGitSnapshot = {
	branch: string | null;
	dirty: boolean;
	log: MonitorGitLogEntry[];
};

export type MonitorTransport = {
	list(path: string): Promise<MonitorListResult>;
	stat(path: string): Promise<MonitorStatResult>;
	download(
		path: string,
		opts?: {
			onProgress?: (transferred: number, total?: number) => void;
			onChunk?: (chunk: Uint8Array) => void | Promise<void>;
			assemble?: boolean;
		}
	): Promise<Blob>;
	/** Overwrite/create a file at `path` (parent must exist). */
	write(
		path: string,
		body: Blob,
		opts?: {
			signal?: AbortSignal;
			onProgress?: (transferred: number, total?: number) => void;
		}
	): Promise<MonitorStatResult>;
	/**
	 * Server-side copy. Streams NDJSON `{ transferred, size, done?, error? }`.
	 */
	copy(
		from: string,
		to: string,
		opts?: {
			signal?: AbortSignal;
			onProgress?: (transferred: number, total?: number) => void;
		}
	): Promise<void>;
	/** Delete a file (or empty directory) at `path`. */
	unlink(path: string, opts?: { signal?: AbortSignal }): Promise<void>;
	health(): Promise<unknown>;
	/** Idempotent POST /v1/watch/roots */
	watchAddRoot(path: string, recursive?: boolean): Promise<MonitorWatchedRoot>;
	watchListRoots(): Promise<{ roots: MonitorWatchedRoot[] }>;
	/**
	 * DELETE /v1/watch/roots/{id} — release a root created by `watchAddRoot`.
	 *
	 * Roots are process-global on the daemon: no per-client ownership, and no
	 * reaping. It drops one ONLY on this call — never when a client disconnects
	 * or its SSE stream closes. A client that adds roots and never removes them
	 * therefore leaks them until the daemon restarts, and once `max_roots`
	 * (default 16) is reached every new subscription fails.
	 *
	 * `force` skips the 409 the daemon returns when other subscribers remain;
	 * pass it only when tearing down roots this client owns.
	 */
	watchRemoveRoot(rootId: string, force?: boolean): Promise<void>;
	/**
	 * POST /v1/watch/subs — change what an open stream watches without
	 * reconnecting it, so navigating does not resync the folders you kept.
	 */
	watchUpdateSubs(req: MonitorSubsRequest): Promise<MonitorSubsResult>;
	hostSnapshot(): Promise<MonitorHostSnapshot>;
	gitSnapshot(path: string): Promise<MonitorGitSnapshot>;
	openHostEvents(opts: {
		onSnapshot: (s: MonitorHostSnapshot) => void;
		signal?: AbortSignal;
	}): Promise<{ abort: () => void }>;
	openGitEvents(
		path: string,
		opts: {
			onSnapshot: (s: MonitorGitSnapshot) => void;
			signal?: AbortSignal;
		}
	): Promise<{ abort: () => void }>;
	/** HTTP base URL (also used for the SSE watch stream). */
	baseUrl: string;
};

function joinUrl(base: string, path: string): string {
	const b = base.replace(/\/$/, '');
	const p = path.startsWith('/') ? path : `/${path}`;
	return `${b}${p}`;
}

function num(v: unknown): number | null {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
	return null;
}

function unwrapRecord(data: unknown): Record<string, unknown> | null {
	if (!data || typeof data !== 'object') return null;
	const o = data as Record<string, unknown>;
	if (o.snapshot && typeof o.snapshot === 'object') {
		return o.snapshot as Record<string, unknown>;
	}
	return o;
}

export function coerceHostSnapshot(data: unknown): MonitorHostSnapshot | null {
	const o = unwrapRecord(data);
	if (!o) return null;
	const cpu = num(o.cpu_pct ?? o.cpuPct);
	const memUsed = num(o.mem_used ?? o.memUsed);
	const memTotal = num(o.mem_total ?? o.memTotal);
	if (cpu == null || memUsed == null || memTotal == null) return null;
	const rawDisks = Array.isArray(o.disks) ? o.disks : [];
	const disks: MonitorHostDisk[] = [];
	for (const d of rawDisks) {
		if (!d || typeof d !== 'object') continue;
		const disk = d as Record<string, unknown>;
		const used = num(disk.used);
		const total = num(disk.total);
		const name = typeof disk.name === 'string' ? disk.name : '';
		if (used == null || total == null) continue;
		disks.push({ name, used, total });
	}
	return { cpu_pct: cpu, mem_used: memUsed, mem_total: memTotal, disks };
}

export function coerceGitSnapshot(data: unknown): MonitorGitSnapshot | null {
	const o = unwrapRecord(data);
	if (!o) return null;
	if (!('branch' in o) && !('dirty' in o) && !('log' in o)) return null;
	const branch = o.branch == null ? null : typeof o.branch === 'string' ? o.branch : null;
	const dirty = Boolean(o.dirty);
	const rawLog = Array.isArray(o.log) ? o.log : [];
	const log: MonitorGitLogEntry[] = [];
	for (const c of rawLog) {
		if (!c || typeof c !== 'object') continue;
		const row = c as Record<string, unknown>;
		const sha = typeof row.sha === 'string' ? row.sha : '';
		const subject = typeof row.subject === 'string' ? row.subject : '';
		if (!sha && !subject) continue;
		const entry: MonitorGitLogEntry = { sha, subject };
		if (typeof row.author === 'string') entry.author = row.author;
		const committed =
			typeof row.committed_at === 'string'
				? row.committed_at
				: typeof row.committedAt === 'string'
					? row.committedAt
					: undefined;
		if (committed) entry.committed_at = committed;
		log.push(entry);
	}
	return { branch, dirty, log };
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
		async watchRemoveRoot(rootId: string, force = true) {
			// Teardown path: a failure here must never surface to the user (the
			// stream is already closing), but leaving it silent entirely would hide
			// a growing leak, so warn.
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 5_000);
			const url = joinUrl(
				base,
				`/v1/watch/roots/${encodeURIComponent(rootId)}${force ? '?force=true' : ''}`
			);
			try {
				const res = await fetchFn(
					url,
					withLocalAddressSpace(url, { method: 'DELETE', signal: ac.signal })
				);
				if (!res.ok && res.status !== 404) {
					console.warn(`[monitor] releasing watch root ${rootId} failed (${res.status})`);
				}
			} catch {
				console.warn(`[monitor] releasing watch root ${rootId} failed (network)`);
			} finally {
				clearTimeout(t);
			}
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
		async download(path: string, opts) {
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
				return blobFromResponse(res, {
					onProgress: opts?.onProgress,
					onChunk: opts?.onChunk,
					assemble: opts?.assemble
				});
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
		},
		async write(path, body, opts) {
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 120_000);
			const onAbort = () => ac.abort();
			opts?.signal?.addEventListener('abort', onAbort);
			const url = joinUrl(base, `/v1/fs/write?path=${encodeURIComponent(path)}`);
			try {
				const res = await fetchFn(
					url,
					withLocalAddressSpace(url, {
						method: 'PUT',
						headers: { 'content-type': body.type || 'application/octet-stream' },
						body,
						signal: ac.signal
					})
				);
				const parsed = await res.json().catch(() => ({}));
				if (!res.ok) {
					const err = (parsed as { error?: { message?: string } | string }).error;
					const msg =
						typeof err === 'string'
							? err
							: err && typeof err === 'object' && 'message' in err
								? String(err.message)
								: res.statusText;
					throw new Error(msg || `Write failed (${res.status})`);
				}
				opts?.onProgress?.(body.size, body.size);
				return parsed as MonitorStatResult;
			} catch (e) {
				if (e instanceof Error && e.name === 'AbortError') {
					throw new Error(
						opts?.signal?.aborted ? 'Monitor write cancelled' : 'Monitor write timed out'
					);
				}
				if (e instanceof TypeError) {
					throw new Error(
						`Cannot reach monitor at ${base} (network/CORS). Is it running and allowing this origin?`
					);
				}
				throw e;
			} finally {
				opts?.signal?.removeEventListener('abort', onAbort);
				clearTimeout(t);
			}
		},
		async copy(from, to, opts) {
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 120_000);
			const onAbort = () => ac.abort();
			opts?.signal?.addEventListener('abort', onAbort);
			const url = joinUrl(base, '/v1/fs/copy');
			try {
				const res = await fetchFn(
					url,
					withLocalAddressSpace(url, {
						method: 'POST',
						headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
						body: JSON.stringify({ from, to }),
						signal: ac.signal
					})
				);
				if (!res.ok) {
					const parsed = await res.json().catch(() => ({}));
					const err = (parsed as { error?: { message?: string } | string }).error;
					const msg =
						typeof err === 'string'
							? err
							: err && typeof err === 'object' && 'message' in err
								? String(err.message)
								: res.statusText;
					throw new Error(msg || `Copy failed (${res.status})`);
				}
				if (!res.body || typeof res.body.getReader !== 'function') {
					opts?.onProgress?.(1, 1);
					return;
				}
				const reader = res.body.getReader();
				const dec = new TextDecoder();
				let buf = '';
				let lastError = '';
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
					const lines = buf.split('\n');
					buf = lines.pop() ?? '';
					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed) continue;
						let ev: { transferred?: number; size?: number; done?: boolean; error?: string };
						try {
							ev = JSON.parse(trimmed) as typeof ev;
						} catch {
							continue;
						}
						if (ev.error) lastError = ev.error;
						opts?.onProgress?.(ev.transferred ?? 0, ev.size);
					}
				}
				if (buf.trim()) {
					try {
						const ev = JSON.parse(buf.trim()) as { transferred?: number; size?: number; error?: string };
						if (ev.error) lastError = ev.error;
						opts?.onProgress?.(ev.transferred ?? 0, ev.size);
					} catch {
						/* ignore trailer */
					}
				}
				if (lastError) throw new Error(lastError);
			} catch (e) {
				if (e instanceof Error && e.name === 'AbortError') {
					throw new Error(
						opts?.signal?.aborted ? 'Monitor copy cancelled' : 'Monitor copy timed out'
					);
				}
				if (e instanceof TypeError) {
					throw new Error(
						`Cannot reach monitor at ${base} (network/CORS). Is it running and allowing this origin?`
					);
				}
				throw e;
			} finally {
				opts?.signal?.removeEventListener('abort', onAbort);
				clearTimeout(t);
			}
		},
		async unlink(path, opts) {
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 15_000);
			const onAbort = () => ac.abort();
			opts?.signal?.addEventListener('abort', onAbort);
			const url = joinUrl(base, `/v1/fs/unlink?path=${encodeURIComponent(path)}`);
			try {
				const res = await fetchFn(
					url,
					withLocalAddressSpace(url, { method: 'DELETE', signal: ac.signal })
				);
				if (!res.ok) {
					const parsed = await res.json().catch(() => ({}));
					const err = (parsed as { error?: { message?: string } | string }).error;
					const msg =
						typeof err === 'string'
							? err
							: err && typeof err === 'object' && 'message' in err
								? String(err.message)
								: res.statusText;
					throw new Error(msg || `Delete failed (${res.status})`);
				}
			} catch (e) {
				if (e instanceof Error && e.name === 'AbortError') {
					throw new Error(
						opts?.signal?.aborted ? 'Monitor delete cancelled' : 'Monitor delete timed out'
					);
				}
				if (e instanceof TypeError) {
					throw new Error(
						`Cannot reach monitor at ${base} (network/CORS). Is it running and allowing this origin?`
					);
				}
				throw e;
			} finally {
				opts?.signal?.removeEventListener('abort', onAbort);
				clearTimeout(t);
			}
		},
		async hostSnapshot() {
			const body = await getJson('/v1/host/snapshot');
			const snap = coerceHostSnapshot(body);
			if (!snap) throw new Error('Monitor host snapshot was malformed');
			return snap;
		},
		async gitSnapshot(path: string) {
			const body = await getJson(`/v1/git/snapshot?path=${encodeURIComponent(path)}`);
			const snap = coerceGitSnapshot(body);
			if (!snap) throw new Error('Monitor git snapshot was malformed');
			return snap;
		},
		async openHostEvents(opts) {
			const url = joinUrl(base, '/v1/host/events');
			return openJsonSse({
				url,
				fetchImpl: fetchFn,
				signal: opts.signal,
				onEvent: (_event, data) => {
					const snap = coerceHostSnapshot(data);
					if (snap) opts.onSnapshot(snap);
				}
			});
		},
		async openGitEvents(path, opts) {
			const url = joinUrl(base, `/v1/git/events?path=${encodeURIComponent(path)}`);
			return openJsonSse({
				url,
				fetchImpl: fetchFn,
				signal: opts.signal,
				onEvent: (_event, data) => {
					const snap = coerceGitSnapshot(data);
					if (snap) opts.onSnapshot(snap);
				}
			});
		}
	};
}
