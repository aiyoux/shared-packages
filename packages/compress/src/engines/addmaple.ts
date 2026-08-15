import { engineInfo, type CompressOptions, type CompressionEngine } from '../types.js';

type MapleMod = {
	init: (imports?: Record<string, unknown>, opts?: { backend?: string }) => Promise<void>;
	compress: (
		input: Uint8Array | ArrayBuffer | string,
		options?: { level?: number }
	) => Promise<Uint8Array>;
	decompress: (input: Uint8Array | ArrayBuffer | string) => Promise<Uint8Array>;
};

type MapleCodec = 'gzip' | 'brotli' | 'lz4';

const loaded: Partial<Record<MapleCodec, MapleMod>> = {};

function mapleLevel(options?: CompressOptions): number {
	if (options?.level === 'speed') return 1;
	if (options?.level === 'ratio') return 9;
	return 6;
}

async function get(codec: MapleCodec): Promise<MapleMod> {
	const hit = loaded[codec];
	if (hit) return hit;
	const raw =
		codec === 'gzip'
			? await import('@addmaple/gzip')
			: codec === 'brotli'
				? await import('@addmaple/brotli')
				: await import('@addmaple/lz4');
	// Published .d.ts only lists `init`; compress/decompress are on the runtime module.
	const mod = raw as unknown as MapleMod;
	await mod.init();
	loaded[codec] = mod;
	return mod;
}

export const addmapleEngine: CompressionEngine = {
	info: engineInfo('addmaple'),

	async load() {
		// Load gzip first (most common); brotli/lz4 load on first use.
		await get('gzip');
	},

	async compress(bytes, codec, options) {
		if (codec !== 'gzip' && codec !== 'brotli' && codec !== 'lz4') {
			throw new Error(`AddMaple cannot compress ${codec}`);
		}
		const mod = await get(codec);
		return mod.compress(bytes, { level: mapleLevel(options) });
	},

	async decompress(bytes, codec) {
		if (codec !== 'gzip' && codec !== 'brotli' && codec !== 'lz4') {
			throw new Error(`AddMaple cannot expand ${codec}`);
		}
		const mod = await get(codec);
		return mod.decompress(bytes);
	}
};
