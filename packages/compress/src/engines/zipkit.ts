import { engineInfo, type ArchiveEntry, type CompressOptions, type CompressionEngine } from '../types.js';

type Zipkit = typeof import('@myrialabs/zipkit');

let mod: Zipkit | null = null;

async function get(): Promise<Zipkit> {
	if (!mod) mod = await import('@myrialabs/zipkit');
	return mod;
}

function modeOf(options?: CompressOptions): 'speed' | 'balanced' | 'ratio' {
	return options?.level ?? 'balanced';
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

	async zip(entries: ArchiveEntry[], _options?: CompressOptions) {
		const z = await get();
		return z.zip(
			entries
				.filter((e) => e.name && !e.name.endsWith('/'))
				.map((e) => ({ name: e.name.replace(/^\/+/, ''), data: e.data }))
		);
	},

	async unzip(bytes: Uint8Array) {
		const z = await get();
		const files = await z.unzip(bytes);
		const out: ArchiveEntry[] = [];
		for (const file of files) {
			const name = typeof file?.name === 'string' ? file.name : '';
			if (!name || name.endsWith('/')) continue;
			const data = file.data;
			if (!(data instanceof Uint8Array)) continue;
			out.push({ name, data });
		}
		return out;
	}
};
