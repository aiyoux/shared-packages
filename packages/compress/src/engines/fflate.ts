import {
	engineInfo,
	type ArchiveEntry,
	type CompressOptions,
	type CompressionEngine,
	type UnzipProgressOpts
} from '../types.js';

type Fflate = typeof import('fflate');

let mod: Fflate | null = null;

async function get(): Promise<Fflate> {
	if (!mod) {
		// The package root's `node` export is worker_threads. In the Vite
		// browser bundle that is an empty module, so `new Worker` throws
		// instead of compressing. The browser entry uses blob workers, and
		// zip() below still falls back to the sync codec if those fail.
		mod = await import('fflate/browser');
	}
	return mod;
}

function asU8(data: Uint8Array): Uint8Array {
	return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function abortIf(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const e = new Error('Cancelled');
	e.name = 'AbortError';
	throw e;
}

/** fflate 0–9. Default 6 matches the library; `speed` is 1 not 0 so tiny files still compress. */
function zipLevel(options?: CompressOptions): 0 | 1 | 6 | 9 {
	if (options?.level === 'speed') return 1;
	if (options?.level === 'ratio') return 9;
	return 6;
}

function entriesFromTree(tree: Record<string, Uint8Array>): ArchiveEntry[] {
	const out: ArchiveEntry[] = [];
	for (const [name, data] of Object.entries(tree)) {
		if (!name || name.endsWith('/')) continue;
		out.push({ name, data });
	}
	return out;
}

function unzipAsync(f: Fflate, input: Uint8Array, signal?: AbortSignal): Promise<Record<string, Uint8Array>> {
	return new Promise((resolve, reject) => {
		const term = f.unzip(input, (err, tree) => {
			signal?.removeEventListener('abort', onAbort);
			if (err) reject(err);
			else resolve(tree);
		});
		const onAbort = () => {
			term();
			const e = new Error('Cancelled');
			e.name = 'AbortError';
			reject(e);
		};
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener('abort', onAbort, { once: true });
		}
	});
}

async function deliver(files: ArchiveEntry[], opts?: UnzipProgressOpts): Promise<ArchiveEntry[]> {
	if (!opts?.onEntry) return files;
	for (const entry of files) {
		abortIf(opts.signal);
		opts.onMember?.({
			name: entry.name,
			transferred: 0,
			size: entry.data.byteLength,
			done: false
		});
		await opts.onEntry(entry);
		opts.onMember?.({
			name: entry.name,
			transferred: entry.data.byteLength,
			size: entry.data.byteLength,
			done: true
		});
	}
	return [];
}

export const fflateEngine: CompressionEngine = {
	info: engineInfo('fflate'),

	async load() {
		await get();
	},

	async compress(bytes, codec, options) {
		const f = await get();
		const input = asU8(bytes);
		const opts = { level: zipLevel(options) };
		if (codec === 'gzip') return f.gzipSync(input, opts);
		if (codec === 'deflate') return f.deflateSync(input, opts);
		if (codec === 'zlib') return f.zlibSync(input, opts);
		throw new Error(`fflate cannot compress ${codec}`);
	},

	async decompress(bytes, codec) {
		const f = await get();
		const input = asU8(bytes);
		if (codec === 'gzip') return f.gunzipSync(input);
		if (codec === 'deflate') return f.inflateSync(input);
		if (codec === 'zlib') return f.unzlibSync(input);
		throw new Error(`fflate cannot expand ${codec}`);
	},

	async zip(entries: ArchiveEntry[], options?: CompressOptions) {
		const f = await get();
		const files: Array<{ name: string; data: Uint8Array }> = [];
		for (const entry of entries) {
			const name = entry.name.replace(/^\/+/, '') || 'file';
			if (name.endsWith('/')) continue;
			files.push({ name, data: asU8(entry.data) });
		}
		const level = zipLevel(options);
		// fflate.zip starts one worker for EVERY member >=160 KB. A folder of
		// photos can therefore create hundreds of workers and duplicate all
		// input buffers before the first finishes. Feed its streaming ZIP writer
		// one member at a time; at most one worker and one clone are live.
		return new Promise<Uint8Array>((resolve, reject) => {
			const chunks: Uint8Array[] = [];
			let total = 0;
			let settled = false;
			const fail = (error: unknown) => {
				if (settled) return;
				settled = true;
				reject(error);
			};
			const zip = new f.Zip((err, chunk, final) => {
				if (err) return fail(err);
				if (chunk) {
					chunks.push(chunk);
					total += chunk.byteLength;
				}
				if (!final || settled) return;
				try {
					const out = new Uint8Array(total);
					let offset = 0;
					for (const part of chunks) {
						out.set(part, offset);
						offset += part.byteLength;
					}
					settled = true;
					resolve(out);
				} catch (error) {
					fail(error);
				}
			});
			void (async () => {
				try {
					for (let i = 0; i < files.length; i++) {
						if (settled) return;
						const { name, data } = files[i]!;
						const stream = data.byteLength >= 160_000 && typeof Worker !== 'undefined'
							? new f.AsyncZipDeflate(name, { level })
							: new f.ZipDeflate(name, { level });
						zip.add(stream);
						await new Promise<void>((done, failMember) => {
							const ondata = stream.ondata;
							stream.ondata = (err, chunk, final) => {
								ondata(err, chunk, final);
								if (err) failMember(err);
								else if (final) done();
							};
							stream.push(data, true);
						});
						if ((i & 31) === 31) await new Promise((done) => setTimeout(done, 0));
					}
					zip.end();
				} catch (error) {
					zip.terminate();
					fail(error);
				}
			})();
		});
	},

	async unzip(bytes: Uint8Array, opts?: UnzipProgressOpts) {
		const f = await get();
		const input = asU8(bytes);
		abortIf(opts?.signal);
		let tree: Record<string, Uint8Array>;
		try {
			// Worker unzip is 2–5× unzipSync on many deflated members.
			tree = await unzipAsync(f, input, opts?.signal);
		} catch (err) {
			if ((err as Error)?.name === 'AbortError') throw err;
			tree = f.unzipSync(input);
		}
		const files = entriesFromTree(tree);
		if (!files.length) throw new Error('empty zip');
		if (!opts?.onEntry) {
			for (const file of files) {
				opts?.onMember?.({
					name: file.name,
					transferred: file.data.byteLength,
					size: file.data.byteLength,
					done: true
				});
			}
			return files;
		}
		return deliver(files, opts);
	}
};
