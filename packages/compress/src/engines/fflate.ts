import { engineInfo, type ArchiveEntry, type CompressOptions, type CompressionEngine } from '../types.js';

type Fflate = typeof import('fflate');

let mod: Fflate | null = null;

async function get(): Promise<Fflate> {
	if (!mod) mod = await import('fflate');
	return mod;
}

function asU8(data: Uint8Array): Uint8Array {
	return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export const fflateEngine: CompressionEngine = {
	info: engineInfo('fflate'),

	async load() {
		await get();
	},

	async compress(bytes, codec) {
		const f = await get();
		const input = asU8(bytes);
		if (codec === 'gzip') return f.gzipSync(input);
		if (codec === 'deflate') return f.deflateSync(input);
		if (codec === 'zlib') return f.zlibSync(input);
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

	async zip(entries: ArchiveEntry[], _options?: CompressOptions) {
		const f = await get();
		const tree: import('fflate').Zippable = {};
		for (const entry of entries) {
			const name = entry.name.replace(/^\/+/, '') || 'file';
			if (name.endsWith('/')) continue;
			tree[name] = asU8(entry.data);
		}
		return f.zipSync(tree);
	},

	async unzip(bytes: Uint8Array) {
		const f = await get();
		const tree = f.unzipSync(asU8(bytes));
		const out: ArchiveEntry[] = [];
		for (const [name, data] of Object.entries(tree)) {
			if (!name || name.endsWith('/')) continue;
			out.push({ name, data });
		}
		return out;
	}
};
