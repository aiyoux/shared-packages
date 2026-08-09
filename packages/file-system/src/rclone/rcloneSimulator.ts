/**
 * In-memory rclone RC simulator for unit tests (B2Simulator analogue).
 * Supports a single logical fs tree keyed by remote path (no leading slash).
 */

export type SimNode = {
	/** path relative to fs, folders end with `/` */
	path: string;
	isDir: boolean;
	/** file body */
	body?: Uint8Array;
	modTime?: number;
	mimeType?: string;
};

export type RcloneCallResult = Record<string, unknown>;

export type RcloneTransport = {
	call(method: string, params?: Record<string, unknown>): Promise<RcloneCallResult>;
	upload(opts: {
		fs: string;
		remote: string;
		body: Blob | File | Uint8Array | ArrayBuffer;
		contentType?: string;
		signal?: AbortSignal;
		onProgress?: (pct: number) => void;
	}): Promise<RcloneCallResult>;
	download(opts: {
		fs: string;
		remote: string;
		signal?: AbortSignal;
	}): Promise<Blob>;
};

function normRemote(remote: string): string {
	return (remote ?? '').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
}

function dirOf(path: string): string {
	const bare = path.replace(/\/+$/, '');
	const i = bare.lastIndexOf('/');
	if (i < 0) return '';
	return bare.slice(0, i + 1);
}

function ensureDir(nodes: Map<string, SimNode>, dirPath: string): void {
	let p = normRemote(dirPath);
	if (!p) return;
	if (!p.endsWith('/')) p += '/';
	const parts = p.replace(/\/$/, '').split('/').filter(Boolean);
	let acc = '';
	for (const part of parts) {
		acc = acc ? `${acc}${part}/` : `${part}/`;
		if (!nodes.has(acc)) {
			nodes.set(acc, { path: acc, isDir: true, modTime: Date.now() });
		}
	}
}

async function toBytes(body: Blob | File | Uint8Array | ArrayBuffer): Promise<Uint8Array> {
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	const ab = await body.arrayBuffer();
	return new Uint8Array(ab);
}

export class RcloneSimulator {
	/** path → node */
	private nodes = new Map<string, SimNode>();
	/** authorized flag for noopauth */
	authorized = true;
	/** force HTTP-like status on next call */
	nextStatus: number | null = null;

	reset(): void {
		this.nodes.clear();
		this.authorized = true;
		this.nextStatus = null;
	}

	seedFile(remote: string, content: string | Uint8Array, mimeType = 'application/octet-stream'): void {
		const path = normRemote(remote).replace(/\/+$/, '');
		if (!path) throw new Error('cannot seed root as file');
		ensureDir(this.nodes, dirOf(path));
		const body = typeof content === 'string' ? new TextEncoder().encode(content) : content;
		this.nodes.set(path, {
			path,
			isDir: false,
			body,
			modTime: Date.now(),
			mimeType
		});
	}

	seedDir(remote: string): void {
		let p = normRemote(remote);
		if (!p.endsWith('/')) p += '/';
		ensureDir(this.nodes, p);
	}

	transport(): RcloneTransport {
		const self = this;
		return {
			async call(method: string, params: Record<string, unknown> = {}) {
				return self.handleCall(method, params);
			},
			async upload(opts) {
				if (opts.signal?.aborted) {
					const e = new Error('aborted');
					(e as Error & { name: string }).name = 'AbortError';
					throw e;
				}
				const remote = normRemote(opts.remote).replace(/\/+$/, '');
				const bytes = await toBytes(opts.body);
				opts.onProgress?.(1);
				ensureDir(self.nodes, dirOf(remote));
				self.nodes.set(remote, {
					path: remote,
					isDir: false,
					body: bytes,
					modTime: Date.now(),
					mimeType: opts.contentType || 'application/octet-stream'
				});
				return {};
			},
			async download(opts) {
				if (opts.signal?.aborted) {
					const e = new Error('aborted');
					(e as Error & { name: string }).name = 'AbortError';
					throw e;
				}
				const remote = normRemote(opts.remote).replace(/\/+$/, '');
				const node = self.nodes.get(remote);
				if (!node || node.isDir || !node.body) {
					const err = new Error('not found') as Error & { status: number };
					err.status = 404;
					throw err;
				}
				return new Blob([node.body], { type: node.mimeType || 'application/octet-stream' });
			}
		};
	}

	private maybeAuth(): void {
		if (this.nextStatus === 401 || !this.authorized) {
			const err = new Error('unauthorized') as Error & { status: number };
			err.status = 401;
			this.nextStatus = null;
			throw err;
		}
		if (this.nextStatus != null) {
			const status = this.nextStatus;
			this.nextStatus = null;
			const err = new Error(`status ${status}`) as Error & { status: number };
			err.status = status;
			throw err;
		}
	}

	private handleCall(method: string, params: Record<string, unknown>): RcloneCallResult {
		this.maybeAuth();
		const remote = normRemote(String(params.remote ?? ''));

		switch (method) {
			case 'rc/noopauth':
			case 'rc/noop':
				return {};

			case 'operations/about':
				return { total: 0, used: 0, free: 0 };

			case 'config/listremotes':
				return { remotes: ['sim'] };

			case 'operations/list': {
				// list non-recursive children of remote (dir)
				let prefix = remote;
				if (prefix && !prefix.endsWith('/')) {
					// listing a file path as dir → empty
					prefix = prefix + '/';
				}
				const list: Array<Record<string, unknown>> = [];
				const seenDirs = new Set<string>();

				for (const node of this.nodes.values()) {
					if (!node.path.startsWith(prefix) && prefix !== '') continue;
					if (prefix === '' && node.path.includes('/')) {
						// top-level only
						const first = node.path.split('/')[0]!;
						if (node.isDir && node.path === `${first}/`) {
							if (!seenDirs.has(first)) {
								seenDirs.add(first);
								list.push({
									Path: first,
									Name: first,
									IsDir: true,
									ModTime: new Date(node.modTime ?? Date.now()).toISOString(),
									Size: -1
								});
							}
							continue;
						}
						if (!node.isDir && !node.path.includes('/')) {
							list.push({
								Path: node.path,
								Name: node.path,
								IsDir: false,
								ModTime: new Date(node.modTime ?? Date.now()).toISOString(),
								Size: node.body?.byteLength ?? 0,
								MimeType: node.mimeType
							});
						} else if (!node.isDir) {
							const top = node.path.split('/')[0]!;
							if (!seenDirs.has(top)) {
								// synthesize virtual folder for nested-only content
								const dirPath = `${top}/`;
								if (!this.nodes.has(dirPath)) {
									seenDirs.add(top);
									list.push({
										Path: top,
										Name: top,
										IsDir: true,
										Size: -1
									});
								}
							}
						}
						continue;
					}

					const rest = prefix ? node.path.slice(prefix.length) : node.path;
					if (!rest) continue;
					const slash = rest.indexOf('/');
					if (slash >= 0) {
						// nested — direct child folder name
						const childName = rest.slice(0, slash);
						const childPath = `${prefix}${childName}`;
						if (!seenDirs.has(childPath)) {
							seenDirs.add(childPath);
							list.push({
								Path: childPath,
								Name: childName,
								IsDir: true,
								Size: -1
							});
						}
						continue;
					}
					// direct child file
					if (!node.isDir) {
						list.push({
							Path: node.path,
							Name: rest,
							IsDir: false,
							ModTime: new Date(node.modTime ?? Date.now()).toISOString(),
							Size: node.body?.byteLength ?? 0,
							MimeType: node.mimeType
						});
					}
				}
				return { list };
			}

			case 'operations/mkdir': {
				let p = remote;
				if (!p.endsWith('/')) p += '/';
				ensureDir(this.nodes, p);
				return {};
			}

			case 'operations/deletefile': {
				const path = remote.replace(/\/+$/, '');
				if (!this.nodes.has(path) || this.nodes.get(path)!.isDir) {
					const err = new Error('not found') as Error & { status: number };
					err.status = 404;
					throw err;
				}
				this.nodes.delete(path);
				return {};
			}

			case 'operations/rmdir': {
				let p = remote;
				if (!p.endsWith('/')) p += '/';
				// empty only
				for (const n of this.nodes.values()) {
					if (n.path !== p && n.path.startsWith(p)) {
						const err = new Error('directory not empty') as Error & { status: number };
						err.status = 400;
						throw err;
					}
				}
				this.nodes.delete(p);
				return {};
			}

			case 'operations/purge': {
				let p = remote;
				if (p && !p.endsWith('/')) p += '/';
				for (const key of [...this.nodes.keys()]) {
					if (key === p || key.startsWith(p) || (!p && key)) {
						if (!p) {
							// purge root — clear all
							this.nodes.delete(key);
						} else if (key === p || key.startsWith(p)) {
							this.nodes.delete(key);
						}
					}
				}
				if (p) this.nodes.delete(p);
				return {};
			}

			case 'operations/movefile': {
				const srcFs = String(params.srcFs ?? params.fs ?? '');
				const dstFs = String(params.dstFs ?? params.fs ?? '');
				void srcFs;
				void dstFs;
				const srcRemote = normRemote(String(params.srcRemote ?? '')).replace(/\/+$/, '');
				const dstRemote = normRemote(String(params.dstRemote ?? '')).replace(/\/+$/, '');
				const node = this.nodes.get(srcRemote);
				if (!node || node.isDir) {
					const err = new Error('not found') as Error & { status: number };
					err.status = 404;
					throw err;
				}
				ensureDir(this.nodes, dirOf(dstRemote));
				this.nodes.delete(srcRemote);
				this.nodes.set(dstRemote, { ...node, path: dstRemote, modTime: Date.now() });
				return {};
			}

			case 'operations/copyfile': {
				const srcRemote = normRemote(String(params.srcRemote ?? '')).replace(/\/+$/, '');
				const dstRemote = normRemote(String(params.dstRemote ?? '')).replace(/\/+$/, '');
				const node = this.nodes.get(srcRemote);
				if (!node || node.isDir || !node.body) {
					const err = new Error('not found') as Error & { status: number };
					err.status = 404;
					throw err;
				}
				ensureDir(this.nodes, dirOf(dstRemote));
				this.nodes.set(dstRemote, {
					...node,
					path: dstRemote,
					body: new Uint8Array(node.body),
					modTime: Date.now()
				});
				return {};
			}

			case 'operations/stat': {
				const path = remote.replace(/\/+$/, '');
				const dirPath = path ? `${path}/` : '';
				const node = this.nodes.get(path) ?? (dirPath ? this.nodes.get(dirPath) : undefined);
				if (!node) {
					// check as dir
					const asDir = remote.endsWith('/') ? remote : `${remote}/`;
					if (!this.nodes.has(asDir) && !this.nodes.has(path)) {
						const err = new Error('not found') as Error & { status: number };
						err.status = 404;
						throw err;
					}
				}
				const n = node ?? this.nodes.get(remote.endsWith('/') ? remote : `${remote}/`)!;
				return {
					item: {
						Path: n.path,
						Name: n.path.replace(/\/+$/, '').split('/').pop() ?? n.path,
						IsDir: n.isDir,
						Size: n.isDir ? -1 : (n.body?.byteLength ?? 0),
						MimeType: n.mimeType,
						ModTime: new Date(n.modTime ?? Date.now()).toISOString()
					}
				};
			}

			default: {
				const err = new Error(`unsupported method ${method}`) as Error & { status: number };
				err.status = 404;
				throw err;
			}
		}
	}
}
