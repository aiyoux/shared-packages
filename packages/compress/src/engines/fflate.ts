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
	if (!mod) mod = await import('fflate');
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
		const tree: import('fflate').Zippable = {};
		for (const entry of entries) {
			const name = entry.name.replace(/^\/+/, '') || 'file';
			if (name.endsWith('/')) continue;
			tree[name] = asU8(entry.data);
		}
		const level = zipLevel(options);
		// Async zip uses workers — faster than zipSync once there is more than
		// one member (fflate's own guidance). Single-file stays sync.
		const names = Object.keys(tree);
		if (names.length <= 1) return f.zipSync(tree, { level });
		return new Promise<Uint8Array>((resolve, reject) => {
			f.zip(tree, { level }, (err, data) => (err ? reject(err) : resolve(data)));
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
