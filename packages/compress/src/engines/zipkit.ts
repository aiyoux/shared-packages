import {
	engineInfo,
	type ArchiveEntry,
	type CompressOptions,
	type CompressionEngine,
	type UnzipProgressOpts
} from '../types.js';

type Zipkit = typeof import('@myrialabs/zipkit');

/** Same cutoff ZipKit uses before it fans entries across a worker pool. */
const PARALLEL_MIN_BYTES = 256 * 1024;

let mod: Zipkit | null = null;
let zipChain: Promise<unknown> = Promise.resolve();

async function get(): Promise<Zipkit> {
	if (!mod) mod = await import('@myrialabs/zipkit');
	return mod;
}

function modeOf(options?: CompressOptions): 'speed' | 'balanced' | 'ratio' {
	return options?.level ?? 'balanced';
}

/** Same-realm copy. WASM views can fail `instanceof Uint8Array` across realms. */
function asU8(data: unknown): Uint8Array | null {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		const v = data as ArrayBufferView;
		return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
	}
	return null;
}

type ZipEntry = {
	name: string;
	data: Uint8Array;
	method: 'store' | 'deflate';
	level: number;
};

/**
 * Browser ZIP. Large deflate archives are compressed on the Web Worker pool,
 * then ZipKit's own container writer runs with `parallel: false` so it does
 * not touch `node:worker_threads`. The writer still calls `deflateCompress`;
 * the patched method returns the bytes the workers already produced.
 */
async function zipInBrowser(
	z: Zipkit,
	mapped: ZipEntry[],
	method: 'store' | 'deflate',
	level: number
): Promise<Uint8Array> {
	const total = mapped.reduce((sum, entry) => sum + entry.data.byteLength, 0);
	const fanOut = method === 'deflate' && mapped.length >= 2 && total >= PARALLEL_MIN_BYTES;
	if (!fanOut) return z.zip(mapped, { parallel: false });

	let compressed: Map<Uint8Array, Uint8Array> | null = null;
	try {
		const pool = await import('./zipkitBrowserPool.js');
		// Main-thread engine (CRC, container) loads while the workers deflate.
		const engineReady = z.getEngine();
		const parts = await pool.deflateEntries(mapped.map((entry) => ({ data: entry.data, level })));
		await engineReady;
		if (parts) compressed = new Map(mapped.map((entry, index) => [entry.data, parts[index]!]));
	} catch {
		compressed = null;
	}
	if (!compressed) return z.zip(mapped, { parallel: false });
	const ready = compressed;

	const engine = await z.getEngine();
	const slot = engine as unknown as {
		deflateCompress(data: Uint8Array, level?: number): Uint8Array;
	};
	const orig = slot.deflateCompress;
	slot.deflateCompress = (data, lv) => {
		const hit = ready.get(data);
		if (hit && (lv ?? 6) === level) return hit;
		return orig.call(engine, data, lv);
	};
	try {
		return await z.zip(mapped, { parallel: false });
	} finally {
		slot.deflateCompress = orig;
	}
}

export const zipkitEngine: CompressionEngine = {
	info: engineInfo('zipkit'),

	async load() {
		await get();
	},

	async compress(bytes, codec, options) {
		const z = await get();
		const opts = { mode: modeOf(options) };
		switch (codec) {
			case 'gzip':
				return z.gzip(bytes, opts);
			case 'deflate':
				return z.deflate(bytes, opts);
			case 'zlib':
				return z.zlib(bytes, opts);
			case 'brotli':
				return z.brotli(bytes, opts);
			case 'lz4':
				return z.lz4(bytes);
			case 'zstd':
				return z.zstd(bytes, opts);
			case 'xz':
				return z.xz(bytes, opts);
			case 'lzma':
				return z.lzma(bytes, opts);
			case 'bzip2':
				return z.bzip2(bytes, opts);
			case 'snappy':
				return z.snappy(bytes);
			default:
				throw new Error(`ZipKit cannot compress ${codec}`);
		}
	},

	async decompress(bytes, codec) {
		const z = await get();
		switch (codec) {
			case 'gzip':
				return z.gunzip(bytes);
			case 'deflate':
				return z.inflate(bytes);
			case 'zlib':
				return z.unzlib(bytes);
			case 'brotli':
				return z.unbrotli(bytes);
			case 'lz4':
				return z.unlz4(bytes);
			case 'zstd':
				return z.unzstd(bytes);
			case 'xz':
				return z.unxz(bytes);
			case 'lzma':
				return z.unlzma(bytes);
			case 'bzip2':
				return z.unbzip2(bytes);
			case 'snappy':
				return z.unsnappy(bytes);
			default:
				throw new Error(`ZipKit cannot expand ${codec}`);
		}
	},

	async zip(entries: ArchiveEntry[], options?: CompressOptions) {
		const z = await get();
		const method: ZipEntry['method'] = options?.level === 'speed' ? 'store' : 'deflate';
		const level = options?.level === 'ratio' ? 9 : options?.level === 'speed' ? 1 : 5;
		const mapped: ZipEntry[] = entries
			.filter((e) => e.name && !e.name.endsWith('/'))
			.map((e) => ({
				name: e.name.replace(/^\/+/, ''),
				data: e.data,
				method,
				level
			}));
		// Node can use ZipKit's worker_threads pool. The browser bundle cannot:
		// Vite resolves that import to an empty module and `new Worker` throws.
		if (typeof window === 'undefined') {
			return z.zip(mapped, method === 'store' ? { parallel: false } : undefined);
		}
		const run = zipChain.then(() => zipInBrowser(z, mapped, method, level));
		zipChain = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	},

	async unzip(bytes: Uint8Array, opts?: UnzipProgressOpts) {
		const z = await get();
		const files = await z.unzip(bytes);
		const out: ArchiveEntry[] = [];
		for (const file of files) {
			if (opts?.signal?.aborted) {
				const e = new Error('Cancelled');
				e.name = 'AbortError';
				throw e;
			}
			const name = typeof file?.name === 'string' ? file.name : '';
			if (!name || name.endsWith('/')) continue;
			const data = asU8(file.data);
			if (!data) continue;
			const entry = { name, data };
			opts?.onMember?.({
				name,
				transferred: 0,
				size: data.byteLength,
				done: false
			});
			// VFS extract streams via onEntry. Returning members without calling
			// it left the writer empty and threw "Nothing to extract".
			if (opts?.onEntry) await opts.onEntry(entry);
			else out.push(entry);
			opts?.onMember?.({
				name,
				transferred: data.byteLength,
				size: data.byteLength,
				done: true
			});
		}
		return out;
	}
};
