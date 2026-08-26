/**
 * Browser client for monitor — talks **directly** to the profile base URL
 * (loopback via SSH tunnel, etc.). No hub/Worker proxy: a Cloudflare Worker
 * cannot reach the user's loopback, so the request has to come from the page.
 *
 * Monitor must allow CORS from the Scratch Pad origin. Requests to loopback are
 * additionally annotated for Local Network Access — see `./localNetwork`.
 */
import { blobFromResponse } from '../readProgress.js';
import { fetchPutBlob } from '../uploadProgress.js';
import { withLocalAddressSpace } from './localNetwork';
import { openJsonSse } from './sse.js';

export type MonitorCapabilities = {
	fs?: { ino?: boolean; rename?: boolean; archive?: boolean; mkdir?: boolean };
	git?: { blob?: boolean };
};

export type MonitorListEntry = {
	name: string;
	path: string;
	kind: 'folder' | 'file' | string;
	size?: number;
	mtime_ms?: number;
	/** Decimal inode, never a number. */
	ino?: string;
	/** Decimal device id, never a number. */
	dev?: string;
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
	/** Decimal inode, never a number. */
	ino?: string;
	/** Decimal device id, never a number. */
	dev?: string;
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

export type MonitorMeta = {
	name?: string;
	version?: string;
	features?: string[];
	capabilities?: MonitorCapabilities;
};

export type MonitorNdjsonEvent = {
	transferred?: number;
	size?: number;
	done?: boolean;
	error?: string;
	ice?: 'checking' | 'connected' | 'failed';
	icePath?: 'host' | 'stun';
	/** Push: `hash` while SHA1-reading the source, `upload` while PUTting to B2. */
	phase?: 'hash' | 'upload' | string;
};

export type MonitorWebrtcRole = 'offerer' | 'answerer';

export type MonitorWebrtcJob = { jobId: string; token: string };

export type MonitorArchiveOp =
	| 'zip'
	| 'tar'
	| 'tgz'
	| 'encrypt'
	| 'unzip'
	| 'untar'
	| 'decrypt';

export type MonitorArchiveRequest = {
	op: MonitorArchiveOp;
	paths: string[];
	to: string;
	password?: string;
};

export type MonitorArchiveResult = {
	path: string;
	size?: number;
	kind: string;
};

export type MonitorTransport = {
	list(path: string): Promise<MonitorListResult>;
	stat(path: string): Promise<MonitorStatResult>;
	/** GET /v1/meta — missing capabilities parse as all-false. */
	meta(): Promise<MonitorMeta>;
	/** POST /v1/fs/rename `{from,to}`. Callers gate on `capabilities.fs.rename`. */
	rename?(from: string, to: string): Promise<void>;
	/** POST /v1/fs/mkdir `{path}`. Callers gate on `capabilities.fs.mkdir`. */
	mkdir?(path: string): Promise<MonitorStatResult>;
	/** GET /v1/git/blob?path=&rev=&file=. Callers gate on `capabilities.git.blob`. */
	gitBlob?(repoPath: string, rev: string, file: string): Promise<Uint8Array>;
	download(
		path: string,
		opts?: {
			onProgress?: (transferred: number, total?: number) => void;
			onChunk?: (chunk: Uint8Array) => void | Promise<void>;
			assemble?: boolean;
			signal?: AbortSignal;
		}
	): Promise<Blob>;
	/** Absolute GET URL for `/v1/fs/read` (no extra headers). */
	readUrl(path: string): string;
	/** Absolute GET URL for `/v1/fs/zip` — Chrome downloads on drop. */
	zipUrl(path: string, filename: string): string;
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
	/** Daemon GET `url` to dest path. NDJSON progress; `X-Fs-Job-Token`. */
	pull(
		url: string,
		to: string,
		opts?: {
			signal?: AbortSignal;
			jobToken?: string;
			onProgress?: (transferred: number, total?: number) => void;
		}
	): Promise<void>;
	/** Daemon PUT local file to a minted upload URL (B2). NDJSON progress. */
	push(
		body: {
			from: string;
			uploadUrl: string;
			token: string;
			fileName: string;
			contentType?: string;
		},
		opts?: {
			signal?: AbortSignal;
			onProgress?: (transferred: number, total?: number) => void;
			onEvent?: (ev: MonitorNdjsonEvent) => void;
		}
	): Promise<void>;
	webrtcCreateJob(body: {
		role: MonitorWebrtcRole;
		from?: string;
		to?: string;
		size?: number;
	}): Promise<MonitorWebrtcJob>;
	/** POST /offer with no body — start gathering. */
	webrtcCreateOffer(
		jobId: string,
		token: string,
		opts?: { signal?: AbortSignal }
	): Promise<{ sdp: string }>;
	/** GET /offer — poll for SDP. */
	webrtcGetOffer(
		jobId: string,
		token: string,
		opts?: { signal?: AbortSignal }
	): Promise<{ sdp: string }>;
	webrtcPostOffer(
		jobId: string,
		token: string,
		sdp: string,
		opts?: { signal?: AbortSignal }
	): Promise<{ sdp: string }>;
	webrtcPostAnswer(
		jobId: string,
		token: string,
		sdp: string,
		opts?: { signal?: AbortSignal }
	): Promise<{ sdp: string }>;
	webrtcProgress(
		jobId: string,
		token: string,
		opts?: {
			signal?: AbortSignal;
			onEvent?: (ev: MonitorNdjsonEvent) => void;
			onProgress?: (transferred: number, total?: number) => void;
		}
	): Promise<void>;
	webrtcAbort(jobId: string, token: string, opts?: { signal?: AbortSignal }): Promise<void>;
	/** Delete a file (or empty directory) at `path`. */
	unlink(path: string, opts?: { signal?: AbortSignal }): Promise<void>;
	/**
	 * Zip / tar / encrypt / extract on the monitor host.
	 * Gated on `capabilities.fs.archive`.
	 */
	archive?(
		req: MonitorArchiveRequest,
		opts?: { signal?: AbortSignal }
	): Promise<MonitorArchiveResult>;
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

/** Inode/dev as decimal strings. Numbers are coerced defensively. */
export function coerceInoDev(v: unknown): string | undefined {
	if (typeof v === 'string' && v !== '') return v;
	if (typeof v === 'number' && Number.isFinite(v)) {
		return Number.isInteger(v) ? String(v) : String(Math.trunc(v));
	}
	if (typeof v === 'bigint') return v.toString();
	return undefined;
}

const FALSE_CAPS: MonitorCapabilities = {
	fs: { ino: false, rename: false, archive: false, mkdir: false },
	git: { blob: false }
};

export function coerceMonitorCapabilities(raw: unknown): MonitorCapabilities {
	if (!raw || typeof raw !== 'object') return { ...FALSE_CAPS, fs: { ...FALSE_CAPS.fs }, git: { ...FALSE_CAPS.git } };
	const o = raw as Record<string, unknown>;
	const fs = o.fs && typeof o.fs === 'object' ? (o.fs as Record<string, unknown>) : {};
	const git = o.git && typeof o.git === 'object' ? (o.git as Record<string, unknown>) : {};
	return {
		fs: {
			ino: fs.ino === true,
			rename: fs.rename === true,
			archive: fs.archive === true,
			mkdir: fs.mkdir === true
		},
		git: { blob: git.blob === true }
	};
}

export function coerceMonitorMeta(data: unknown): MonitorMeta {
	const o = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
	const out: MonitorMeta = {
		capabilities: coerceMonitorCapabilities(o.capabilities)
	};
	if (typeof o.name === 'string') out.name = o.name;
	if (typeof o.version === 'string') out.version = o.version;
	if (Array.isArray(o.features)) {
		out.features = o.features.filter((f): f is string => typeof f === 'string');
	}
	return out;
}

export function coerceWebrtcJob(data: unknown, headerToken?: string | null): MonitorWebrtcJob {
	const o = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
	const jobId =
		typeof o.jobId === 'string'
			? o.jobId
			: typeof o.job_id === 'string'
				? o.job_id
				: '';
	const token =
		typeof o.token === 'string'
			? o.token
			: typeof o.jobToken === 'string'
				? o.jobToken
				: headerToken && headerToken !== ''
					? headerToken
					: '';
	if (!jobId || !token) {
		throw new Error('Monitor webrtc job missing jobId/token');
	}
	return { jobId, token };
}

export function coerceSdp(data: unknown): { sdp: string } {
	const o = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
	return { sdp: typeof o.sdp === 'string' ? o.sdp : '' };
}

function errorMessageFromBody(parsed: unknown, fallback: string): string {
	const err = (parsed as { error?: { message?: string; code?: string } | string } | null)?.error;
	const msg =
		typeof err === 'string'
			? err
			: err && typeof err === 'object' && 'message' in err
				? String(err.message)
				: fallback;
	const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
	return code ? `[${code}] ${msg}` : msg || fallback;
}

function jobAuthHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		'X-Fs-Job-Token': token,
		...extra
	};
}

function mapMonitorFetchError(
	e: unknown,
	base: string,
	label: string,
	signal?: AbortSignal
): Error {
	if (e instanceof Error && e.name === 'AbortError') {
		return new Error(signal?.aborted ? `Monitor ${label} cancelled` : `Monitor ${label} timed out`);
	}
	if (e instanceof TypeError) {
		return new Error(
			`Cannot reach monitor at ${base} (network/CORS). Is it running and allowing this origin?`
		);
	}
	return e instanceof Error ? e : new Error(String(e));
}

export function parseNdjsonEvent(line: string): MonitorNdjsonEvent | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed) as MonitorNdjsonEvent;
	} catch {
		return null;
	}
}

async function consumeNdjsonProgress(
	res: Response,
	onEvent?: (ev: MonitorNdjsonEvent) => void
): Promise<void> {
	if (!res.body || typeof res.body.getReader !== 'function') {
		onEvent?.({ transferred: 1, size: 1, done: true });
		return;
	}
	const reader = res.body.getReader();
	const dec = new TextDecoder();
	let buf = '';
	let lastError = '';
	const take = (raw: string) => {
		const ev = parseNdjsonEvent(raw);
		if (!ev) return;
		if (ev.error) lastError = ev.error;
		onEvent?.(ev);
	};
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		const lines = buf.split('\n');
		buf = lines.pop() ?? '';
		for (const line of lines) take(line);
	}
	if (buf.trim()) take(buf);
	if (lastError) throw new Error(lastError);
}

function coerceFsEntry(raw: unknown): MonitorListEntry | null {
	if (!raw || typeof raw !== 'object') return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.name !== 'string' || typeof o.path !== 'string') return null;
	const entry: MonitorListEntry = {
		name: o.name,
		path: o.path,
		kind: typeof o.kind === 'string' ? o.kind : 'file'
	};
	const size = num(o.size);
	if (size != null) entry.size = size;
	const mtime = num(o.mtime_ms);
	if (mtime != null) entry.mtime_ms = mtime;
	const ino = coerceInoDev(o.ino);
	if (ino !== undefined) entry.ino = ino;
	const dev = coerceInoDev(o.dev);
	if (dev !== undefined) entry.dev = dev;
	return entry;
}

export function coerceListResult(data: unknown): MonitorListResult {
	const o = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
	const entries: MonitorListEntry[] = [];
	if (Array.isArray(o.entries)) {
		for (const item of o.entries) {
			const e = coerceFsEntry(item);
			if (e) entries.push(e);
		}
	}
	return {
		path: typeof o.path === 'string' ? o.path : '',
		entries,
		truncated: Boolean(o.truncated)
	};
}

export function coerceStatResult(data: unknown): MonitorStatResult {
	const entry = coerceFsEntry(data);
	if (entry) return entry;
	const o = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
	return {
		name: typeof o.name === 'string' ? o.name : '',
		path: typeof o.path === 'string' ? o.path : '',
		kind: typeof o.kind === 'string' ? o.kind : 'file'
	};
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

	async function postNdjson(
		path: string,
		body: unknown,
		opts: {
			timeoutMs: number;
			signal?: AbortSignal;
			onProgress?: (transferred: number, total?: number) => void;
			onEvent?: (ev: MonitorNdjsonEvent) => void;
			failLabel: string;
			timeoutLabel: string;
			headers?: Record<string, string>;
		}
	): Promise<void> {
		const ac = new AbortController();
		const t = opts.timeoutMs > 0 ? setTimeout(() => ac.abort(), opts.timeoutMs) : null;
		const onAbort = () => ac.abort();
		opts.signal?.addEventListener('abort', onAbort);
		const url = joinUrl(base, path);
		try {
			const res = await fetchFn(
				url,
				withLocalAddressSpace(url, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						accept: 'application/x-ndjson',
						...opts.headers
					},
					body: JSON.stringify(body),
					signal: ac.signal
				})
			);
			if (!res.ok) {
				const parsed = await res.json().catch(() => ({}));
				throw new Error(errorMessageFromBody(parsed, `${opts.failLabel} failed (${res.status})`));
			}
			await consumeNdjsonProgress(res, (ev) => {
				opts.onEvent?.(ev);
				opts.onProgress?.(ev.transferred ?? 0, ev.size);
			});
		} catch (e) {
			throw mapMonitorFetchError(e, base, opts.timeoutLabel, opts.signal);
		} finally {
			opts.signal?.removeEventListener('abort', onAbort);
			if (t) clearTimeout(t);
		}
	}

	async function webrtcJson(
		method: 'GET' | 'POST',
		jobId: string,
		token: string,
		suffix: 'offer' | 'answer',
		body: unknown,
		signal?: AbortSignal
	): Promise<{ sdp: string }> {
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), 30_000);
		const onAbort = () => ac.abort();
		signal?.addEventListener('abort', onAbort);
		const url = joinUrl(base, `/v1/fs/webrtc/jobs/${encodeURIComponent(jobId)}/${suffix}`);
		try {
			const res = await fetchFn(
				url,
				withLocalAddressSpace(url, {
					method,
					headers: jobAuthHeaders(
						token,
						method === 'POST' ? { 'content-type': 'application/json' } : { accept: 'application/json' }
					),
					body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
					signal: ac.signal
				})
			);
			const parsed = await res.json().catch(() => ({}));
			if (!res.ok) {
				throw new Error(errorMessageFromBody(parsed, `Webrtc ${suffix} failed (${res.status})`));
			}
			return coerceSdp(parsed);
		} catch (e) {
			throw mapMonitorFetchError(e, base, `webrtc ${suffix}`, signal);
		} finally {
			signal?.removeEventListener('abort', onAbort);
			clearTimeout(t);
		}
	}

	return {
		baseUrl: base,
		async list(path: string) {
			return coerceListResult(
				await getJson(`/v1/fs/list?path=${encodeURIComponent(path)}`)
			);
		},
		async stat(path: string) {
			return coerceStatResult(
				await getJson(`/v1/fs/stat?path=${encodeURIComponent(path)}`)
			);
		},
		async meta() {
			return coerceMonitorMeta(await getJson('/v1/meta'));
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
		readUrl(path: string) {
			return joinUrl(base, `/v1/fs/read?path=${encodeURIComponent(path)}`);
		},
		zipUrl(path: string, filename: string) {
			const name = filename.trim() || 'archive.zip';
			return joinUrl(
				base,
				`/v1/fs/zip?path=${encodeURIComponent(path)}&download=${encodeURIComponent(name)}`
			);
		},
		async download(path: string, opts) {
			const ac = new AbortController();
			const onAbort = () => ac.abort();
			opts?.signal?.addEventListener('abort', onAbort);
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
					throw opts?.signal?.aborted ? e : new Error('Monitor download aborted');
				}
				if (e instanceof TypeError) {
					throw new Error(
						`Cannot reach monitor at ${base} (network/CORS). Is it running and allowing this origin?`
					);
				}
				throw e;
			} finally {
				opts?.signal?.removeEventListener('abort', onAbort);
			}
		},
		async write(path, body, opts) {
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 120_000);
			const onAbort = () => ac.abort();
			opts?.signal?.addEventListener('abort', onAbort);
			const url = joinUrl(base, `/v1/fs/write?path=${encodeURIComponent(path)}`);
			try {
				const res = await fetchPutBlob({
					url,
					body,
					headers: { 'content-type': body.type || 'application/octet-stream' },
					signal: ac.signal,
					onProgress: opts?.onProgress,
					fetchImpl: fetchFn,
					extraInit: withLocalAddressSpace(url, { method: 'PUT' })
				});
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
						`Monitor upload failed at ${base} (connection dropped). The file may not have arrived — check the dest folder and retry.`
					);
				}
				throw e;
			} finally {
				opts?.signal?.removeEventListener('abort', onAbort);
				clearTimeout(t);
			}
		},
		async copy(from, to, opts) {
			await postNdjson('/v1/fs/copy', { from, to }, {
				timeoutMs: 120_000,
				signal: opts?.signal,
				onProgress: opts?.onProgress,
				failLabel: 'Copy',
				timeoutLabel: 'copy'
			});
		},
		async pull(pullUrl, to, opts) {
			const jobToken = opts?.jobToken || (typeof crypto !== 'undefined' && crypto.randomUUID
				? crypto.randomUUID()
				: `pull_${Date.now()}`);
			await postNdjson(
				'/v1/fs/pull',
				{ url: pullUrl, to },
				{
					timeoutMs: 0,
					signal: opts?.signal,
					onProgress: opts?.onProgress,
					failLabel: 'Pull',
					timeoutLabel: 'pull',
					headers: { 'X-Fs-Job-Token': jobToken }
				}
			);
		},
		async push(body, opts) {
			await postNdjson('/v1/fs/push', body, {
				timeoutMs: 0,
				signal: opts?.signal,
				onProgress: opts?.onProgress,
				onEvent: opts?.onEvent,
				failLabel: 'Push',
				timeoutLabel: 'push'
			});
		},
		async webrtcCreateJob(body) {
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 12_000);
			const url = joinUrl(base, '/v1/fs/webrtc/jobs');
			try {
				const res = await fetchFn(
					url,
					withLocalAddressSpace(url, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(body),
						signal: ac.signal
					})
				);
				const parsed = await res.json().catch(() => ({}));
				if (!res.ok) {
					throw new Error(errorMessageFromBody(parsed, `Create webrtc job failed (${res.status})`));
				}
				return coerceWebrtcJob(parsed, res.headers.get('X-Fs-Job-Token'));
			} catch (e) {
				throw mapMonitorFetchError(e, base, 'webrtc job');
			} finally {
				clearTimeout(t);
			}
		},
		async webrtcCreateOffer(jobId, token, opts) {
			return webrtcJson('POST', jobId, token, 'offer', undefined, opts?.signal);
		},
		async webrtcGetOffer(jobId, token, opts) {
			return webrtcJson('GET', jobId, token, 'offer', undefined, opts?.signal);
		},
		async webrtcPostOffer(jobId, token, sdp, opts) {
			return webrtcJson('POST', jobId, token, 'answer', { sdp }, opts?.signal);
		},
		async webrtcPostAnswer(jobId, token, sdp, opts) {
			return webrtcJson('POST', jobId, token, 'answer', { sdp }, opts?.signal);
		},
		async webrtcProgress(jobId, token, opts) {
			const ac = new AbortController();
			const onAbort = () => ac.abort();
			opts?.signal?.addEventListener('abort', onAbort);
			const url = joinUrl(base, `/v1/fs/webrtc/jobs/${encodeURIComponent(jobId)}/progress`);
			try {
				const res = await fetchFn(
					url,
					withLocalAddressSpace(url, {
						method: 'GET',
						headers: jobAuthHeaders(token, { accept: 'application/x-ndjson' }),
						signal: ac.signal
					})
				);
				if (!res.ok) {
					const parsed = await res.json().catch(() => ({}));
					throw new Error(errorMessageFromBody(parsed, `Webrtc progress failed (${res.status})`));
				}
				await consumeNdjsonProgress(res, (ev) => {
					opts?.onEvent?.(ev);
					opts?.onProgress?.(ev.transferred ?? 0, ev.size);
				});
			} catch (e) {
				throw mapMonitorFetchError(e, base, 'webrtc progress', opts?.signal);
			} finally {
				opts?.signal?.removeEventListener('abort', onAbort);
			}
		},
		async webrtcAbort(jobId, token, opts) {
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 15_000);
			const onAbort = () => ac.abort();
			opts?.signal?.addEventListener('abort', onAbort);
			const url = joinUrl(base, `/v1/fs/webrtc/jobs/${encodeURIComponent(jobId)}/abort`);
			try {
				const res = await fetchFn(
					url,
					withLocalAddressSpace(url, {
						method: 'POST',
						headers: jobAuthHeaders(token, { 'content-type': 'application/json' }),
						body: '{}',
						signal: ac.signal
					})
				);
				if (!res.ok && res.status !== 404) {
					const parsed = await res.json().catch(() => ({}));
					throw new Error(errorMessageFromBody(parsed, `Webrtc abort failed (${res.status})`));
				}
			} catch (e) {
				throw mapMonitorFetchError(e, base, 'webrtc abort', opts?.signal);
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
		async archive(req, opts) {
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 300_000);
			const onAbort = () => ac.abort();
			opts?.signal?.addEventListener('abort', onAbort);
			const url = joinUrl(base, '/v1/fs/archive');
			try {
				const res = await fetchFn(
					url,
					withLocalAddressSpace(url, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							op: req.op,
							paths: req.paths,
							to: req.to,
							...(req.password ? { password: req.password } : {})
						}),
						signal: ac.signal
					})
				);
				const parsed = await res.json().catch(() => ({}));
				if (!res.ok) {
					const err = (parsed as { error?: { message?: string; code?: string } | string }).error;
					const msg =
						typeof err === 'string'
							? err
							: err && typeof err === 'object' && 'message' in err
								? String(err.message)
								: res.statusText;
					throw new Error(msg || `Archive failed (${res.status})`);
				}
				const o = parsed as { path?: string; size?: number; kind?: string };
				return {
					path: typeof o.path === 'string' ? o.path : req.to,
					size: typeof o.size === 'number' ? o.size : undefined,
					kind: typeof o.kind === 'string' ? o.kind : 'file'
				};
			} catch (e) {
				if (e instanceof Error && e.name === 'AbortError') {
					throw new Error(
						opts?.signal?.aborted ? 'Monitor archive cancelled' : 'Monitor archive timed out'
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
		async rename(from: string, to: string) {
			await postJson('/v1/fs/rename', { from, to });
		},
		async mkdir(path: string) {
			return (await postJson('/v1/fs/mkdir', { path })) as MonitorStatResult;
		},
		async gitBlob(repoPath: string, rev: string, file: string) {
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 60_000);
			const url = joinUrl(
				base,
				`/v1/git/blob?path=${encodeURIComponent(repoPath)}&rev=${encodeURIComponent(rev)}&file=${encodeURIComponent(file)}`
			);
			try {
				const res = await fetchFn(
					url,
					withLocalAddressSpace(url, { method: 'GET', signal: ac.signal })
				);
				if (!res.ok) {
					const text = await res.text().catch(() => '');
					throw new Error(text || `Git blob failed (${res.status})`);
				}
				return new Uint8Array(await res.arrayBuffer());
			} catch (e) {
				if (e instanceof Error && e.name === 'AbortError') {
					throw new Error('Monitor git blob timed out');
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
