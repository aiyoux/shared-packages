/**
 * Browser client for a monitor's `/v1/b2/**` routes.
 *
 * The monitor holds the keys and makes every B2 call; this tab only ever
 * sends explorer operations and file bytes to its own monitor. Errors come
 * back as `ExplorerB2Error` with the explorer's `B2_*` codes.
 */
import { blobFromResponse, streamFromResponse } from '../readProgress.js';
import { createStallTimer } from '../stallTimer.js';
import { chunkedUpload, MonitorChangedOnHostError, MONITOR_STALL_MS, parseNdjsonEvent } from '../monitor/client.js';
import { withLocalAddressSpace } from '../monitor/localNetwork.js';
import { b2ErrorFromWire, ExplorerB2Error, mapB2Error } from './errors.js';
import type { B2ConnectionInput, MonitorB2Connection } from './types.js';

/** One entry as the monitor lists it. Folder ids end with `/`. */
export type MonitorB2Entry = {
	id: string;
	name: string;
	kind: 'file' | 'folder';
	size?: number;
	updatedAt?: number;
	contentType?: string;
};

export type MonitorB2Listing = {
	/** The connection's effective root prefix (`''` = whole bucket). */
	root: string;
	entries: MonitorB2Entry[];
	truncated: boolean;
};

/** Final NDJSON line of a finish / transfer. */
export type MonitorB2Done = {
	done: true;
	entry?: MonitorB2Entry;
	path?: string;
};

export type MonitorB2Minted = { url: string; filename: string; size?: number; expiresAt?: number };

export type MonitorB2MintedUpload = {
	uploadUrl: string;
	authorizationToken: string;
	destFileName: string;
	contentType?: string;
};

/** `/transfer` endpoints (see the monitor design doc). */
export type MonitorB2From =
	| { connection: string; key: string }
	| { path: string }
	| { url: string; name: string; size?: number };
export type MonitorB2To =
	| { connection: string; parent?: string | null; name?: string }
	| { path: string };

type Progress = (transferred: number, total?: number) => void;

const JSON_TIMEOUT_MS = 30_000;

export type MonitorB2Client = ReturnType<typeof createMonitorB2Client>;

export function createMonitorB2Client(opts: { baseUrl: string; fetchImpl?: typeof fetch }) {
	const base = opts.baseUrl.replace(/\/+$/, '');
	const fetchFn = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
	const url = (path: string) => `${base}/v1/b2${path}`;
	const conn = (id: string, op: string) => `/connections/${encodeURIComponent(id)}/${op}`;

	async function throwFor(res: Response): Promise<never> {
		const parsed = (await res.json().catch(() => ({}))) as {
			error?: { code?: string; message?: string };
		};
		if (res.status === 404 && !parsed.error) {
			throw new ExplorerB2Error(
				'B2_UNSUPPORTED',
				'This monitor has no B2 support — update the daemon.'
			);
		}
		throw b2ErrorFromWire(parsed.error?.code, parsed.error?.message || res.statusText);
	}

	async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), JSON_TIMEOUT_MS);
		const target = url(path);
		try {
			const res = await fetchFn(
				target,
				withLocalAddressSpace(target, {
					method,
					headers: body === undefined ? undefined : { 'content-type': 'application/json' },
					body: body === undefined ? undefined : JSON.stringify(body),
					signal: ac.signal
				})
			);
			if (!res.ok) await throwFor(res);
			return (await res.json()) as T;
		} catch (e) {
			throw mapB2Error(e);
		} finally {
			clearTimeout(t);
		}
	}

	/** Read NDJSON until the result line; progress ticks restart the stall timer. */
	async function ndjson(
		res: Response,
		stall: { bump(): void },
		onProgress?: Progress
	): Promise<MonitorB2Done> {
		if (!res.ok) await throwFor(res);
		if (!res.body) throw new ExplorerB2Error('B2_ERROR', 'Monitor sent no progress stream');
		const reader = res.body.getReader();
		const dec = new TextDecoder();
		let buf = '';
		let last: Record<string, unknown> | null = null;
		const take = (line: string) => {
			const ev = parseNdjsonEvent(line) as Record<string, unknown> | null;
			if (!ev) return;
			stall.bump();
			last = ev;
			if (typeof ev.transferred === 'number' && !ev.error) {
				onProgress?.(ev.transferred, typeof ev.size === 'number' ? ev.size : undefined);
			}
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
		const final = last as Record<string, unknown> | null;
		if (!final || final.done !== true) {
			throw new ExplorerB2Error('B2_NETWORK', 'Monitor stream ended before the transfer finished');
		}
		if (typeof final.error === 'string') {
			throw b2ErrorFromWire(final.code as string | undefined, final.error);
		}
		return final as unknown as MonitorB2Done;
	}

	return {
		baseUrl: base,

		async listConnections(): Promise<MonitorB2Connection[]> {
			const res = await request<{ connections?: MonitorB2Connection[] }>('GET', '/connections');
			return res.connections ?? [];
		},
		createConnection(input: B2ConnectionInput): Promise<MonitorB2Connection> {
			return request('POST', '/connections', input);
		},
		/** An empty/absent `key` keeps the stored one. */
		updateConnection(id: string, patch: Partial<B2ConnectionInput>): Promise<MonitorB2Connection> {
			return request('PATCH', `/connections/${encodeURIComponent(id)}`, patch);
		},
		async deleteConnection(id: string): Promise<void> {
			await request('DELETE', `/connections/${encodeURIComponent(id)}`);
		},

		list(id: string, parent: string | null): Promise<MonitorB2Listing> {
			const q = parent ? `?parent=${encodeURIComponent(parent)}` : '';
			return request('GET', `${conn(id, 'list')}${q}`);
		},
		stat(id: string, key: string): Promise<MonitorB2Entry> {
			return request('GET', `${conn(id, 'stat')}?key=${encodeURIComponent(key)}`);
		},
		mkdir(id: string, parent: string | null, name: string): Promise<MonitorB2Entry> {
			return request('POST', conn(id, 'mkdir'), { parent, name });
		},
		async remove(id: string, key: string): Promise<void> {
			await request('POST', conn(id, 'delete'), { key });
		},
		rename(id: string, key: string, name: string): Promise<MonitorB2Entry> {
			return request('POST', conn(id, 'rename'), { key, name });
		},
		move(id: string, key: string, parent: string | null): Promise<MonitorB2Entry> {
			return request('POST', conn(id, 'move'), { key, parent });
		},
		copy(id: string, key: string, parent: string | null): Promise<MonitorB2Entry> {
			return request('POST', conn(id, 'copy'), { key, parent });
		},
		mintDownload(id: string, key: string): Promise<MonitorB2Minted> {
			return request('POST', conn(id, 'mint-download'), { key });
		},
		mintUpload(
			id: string,
			parent: string | null,
			name: string,
			contentType?: string
		): Promise<MonitorB2MintedUpload> {
			return request('POST', conn(id, 'mint-upload'), { parent, name, contentType });
		},
		startLarge(
			id: string,
			parent: string | null,
			name: string,
			contentType?: string
		): Promise<{ fileId: string; destFileName: string; partSize: number; contentType?: string }> {
			return request('POST', conn(id, 'large/start'), { parent, name, contentType });
		},
		partUrl(id: string, fileId: string): Promise<{ uploadUrl: string; authorizationToken: string }> {
			return request('POST', conn(id, 'large/part-url'), { fileId });
		},
		async finishLarge(id: string, fileId: string, partSha1Array: string[]): Promise<void> {
			await request('POST', conn(id, 'large/finish'), { fileId, partSha1Array });
		},
		async cancelLarge(id: string, fileId: string): Promise<void> {
			await request('POST', conn(id, 'large/cancel'), { fileId });
		},

		/** A URL this tab (or a drag-out target) can GET; the monitor streams it. */
		/** Pixel size of an image object, from its first bytes. */
		imageInfo(id: string, key: string): Promise<{ width: number; height: number; format: string }> {
			return request('GET', `${conn(id, 'image-info')}?key=${encodeURIComponent(key)}`);
		},
		/** A playable stream of an object the browser cannot decode, from `start` seconds. */
		mediaUrl(id: string, key: string, start?: number): string {
			const t = start && start > 0 ? `&t=${Math.round(start * 1000) / 1000}` : '';
			return `${url(conn(id, 'media'))}?key=${encodeURIComponent(key)}${t}`;
		},
		mediaInfo(id: string, key: string, start?: number): Promise<{ duration?: unknown; start?: unknown }> {
			const t = start && start > 0 ? `&t=${start}` : '';
			return request('GET', `${conn(id, 'media-info')}?key=${encodeURIComponent(key)}${t}`);
		},
		peaks(id: string, key: string, n: number): Promise<{ peaks?: unknown; duration?: unknown }> {
			return request('GET', `${conn(id, 'peaks')}?key=${encodeURIComponent(key)}&n=${Math.round(n)}`);
		},
		/** JPEG of an image object, rendered on the monitor (up to 4096 px). */
		thumbUrl(id: string, key: string, size: number): string {
			const dim = Math.max(16, Math.min(4096, Math.round(size) || 96));
			return `${url(conn(id, 'thumb'))}?key=${encodeURIComponent(key)}&size=${dim}`;
		},
		downloadUrl(id: string, key: string): string {
			return url(`${conn(id, 'download')}?key=${encodeURIComponent(key)}`);
		},

		async download(
			id: string,
			key: string,
			o?: { signal?: AbortSignal; onProgress?: Progress }
		): Promise<Blob> {
			const stall = createStallTimer(MONITOR_STALL_MS, o?.signal, 'B2 download');
			const target = url(`${conn(id, 'download')}?key=${encodeURIComponent(key)}`);
			try {
				const res = await fetchFn(
					target,
					withLocalAddressSpace(target, { method: 'GET', signal: stall.signal })
				);
				if (!res.ok) await throwFor(res);
				return await blobFromResponse(res, {
					onProgress: (n: number, total?: number) => {
						stall.bump();
						o?.onProgress?.(n, total);
					}
				});
			} catch (e) {
				throw mapB2Error(e);
			} finally {
				stall.dispose();
			}
		},

		/** Stream the object. No Blob and no 100 MiB cap; the caller writes each chunk. */
		async openDownloadStream(
			id: string,
			key: string,
			o?: { signal?: AbortSignal; onProgress?: Progress }
		): Promise<{ stream: ReadableStream<Uint8Array>; contentType?: string; size?: number }> {
			const stall = createStallTimer(MONITOR_STALL_MS, o?.signal, 'B2 download');
			const target = url(`${conn(id, 'download')}?key=${encodeURIComponent(key)}`);
			try {
				const res = await fetchFn(
					target,
					withLocalAddressSpace(target, { method: 'GET', signal: stall.signal })
				);
				if (!res.ok) {
					stall.dispose();
					await throwFor(res);
				}
				const size = Number(res.headers.get('content-length') || '') || undefined;
				const contentType = res.headers.get('content-type') || undefined;
				const stream = streamFromResponse(res, {
					bump: () => stall.bump(),
					signal: stall.signal,
					onProgress: o?.onProgress,
					onDone: () => stall.dispose()
				});
				return { stream, contentType, size };
			} catch (e) {
				stall.dispose();
				throw mapB2Error(e);
			}
		},

		/** Chunked upload through the monitor; it pushes to B2 at finish. */
		async upload(
			id: string,
			parent: string | null,
			file: Blob & { name?: string; type?: string },
			name: string,
			o?: {
				signal?: AbortSignal;
				onProgress?: (fraction: number) => void;
				/**
				 * Write over `parent + name` (B2 keeps the old version) instead of
				 * taking a free name. With `expectUpdatedAt`, the monitor refuses
				 * when the object's upload timestamp moved on.
				 */
				replace?: { expectUpdatedAt?: number };
			}
		): Promise<MonitorB2Entry> {
			const size = file.size;
			// Bytes to the monitor are the first half of the bar; monitor → B2
			// (reported by the finish stream) is the second. Once finish has
			// started, the uploader's own "all sent" tick must not pull the bar
			// back to the halfway mark.
			let finishing = false;
			const half = (n: number, total: number) => {
				if (finishing) return;
				o?.onProgress?.(total > 0 ? Math.min(1, n / total) / 2 : 0);
			};
			try {
				const done = await chunkedUpload(
					base,
					{
						beginPath: `/v1/b2${conn(id, 'upload')}`,
						beginBody: {
							parent,
							name,
							size,
							contentType: file.type || undefined,
							...(o?.replace
								? {
										replace: true,
										...(o.replace.expectUpdatedAt !== undefined
											? { expectUpdatedAt: o.replace.expectUpdatedAt }
											: {})
									}
								: {})
						},
						jobPath: '/v1/b2/upload',
						readFinish: async (res) => {
							if (res.status === 409) {
								const parsed = (await res.json().catch(() => ({}))) as {
									error?: { code?: string; message?: string };
								};
								if (parsed.error?.code === 'b2.changed') {
									throw new MonitorChangedOnHostError(parsed.error.message);
								}
								throw b2ErrorFromWire(parsed.error?.code, parsed.error?.message || res.statusText);
							}
							finishing = true;
							const stall = createStallTimer(MONITOR_STALL_MS, o?.signal, 'B2 upload');
							try {
								return await ndjson(res, stall, (n, total) => {
									const t = total ?? size;
									o?.onProgress?.(0.5 + (t > 0 ? Math.min(1, n / t) : 1) / 2);
								});
							} finally {
								stall.dispose();
							}
						}
					},
					file,
					{ signal: o?.signal, onProgress: half },
					fetchFn
				);
				o?.onProgress?.(1);
				if (!done.entry) throw new ExplorerB2Error('B2_ERROR', 'Upload finished without an entry');
				return done.entry;
			} catch (e) {
				if (e instanceof MonitorChangedOnHostError) throw e;
				throw mapB2Error(e);
			}
		},

		/** Copy without the bytes touching this tab. */
		async transfer(
			from: MonitorB2From,
			to: MonitorB2To,
			o?: { signal?: AbortSignal; onProgress?: Progress }
		): Promise<MonitorB2Done> {
			const stall = createStallTimer(MONITOR_STALL_MS, o?.signal, 'B2 transfer');
			const target = url('/transfer');
			try {
				const res = await fetchFn(
					target,
					withLocalAddressSpace(target, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ from, to }),
						signal: stall.signal
					})
				);
				return await ndjson(res, stall, o?.onProgress);
			} catch (e) {
				throw mapB2Error(e);
			} finally {
				stall.dispose();
			}
		}
	};
}
