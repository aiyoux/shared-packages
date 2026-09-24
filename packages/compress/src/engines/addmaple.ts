import { engineInfo, type CompressOptions, type CompressionEngine } from '../types.js';
import {
	alloc,
	free,
	memoryU8,
	wasmExports
} from '../../../../node_modules/@addmaple/lz4/dist/core.js';

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
		if (codec === 'lz4') return decompressLz4(mod, bytes);
		return mod.decompress(bytes);
	}
};

/**
 * AddMaple's frame decoder sizes the output at `compressedLen * 10`. When the
 * file beats that ratio the wasm call returns `-originalSize` (`decompress_lz4
 * failed: -80000` for 80 KB of zeros). Retry with that exact length. The
 * instance is the one `init()` already loaded — core.js is a singleton.
 */
function lz4Shortfall(error: unknown): number | null {
	const message = error instanceof Error ? error.message : String(error);
	const match = /decompress_lz4 failed: -(\d+)/.exec(message);
	if (!match) return null;
	const needed = Number(match[1]);
	return Number.isFinite(needed) && needed > 0 ? needed : null;
}

async function decompressLz4(mod: MapleMod, bytes: Uint8Array): Promise<Uint8Array> {
	try {
		return await mod.decompress(bytes);
	} catch (error) {
		const needed = lz4Shortfall(error);
		if (needed == null) throw error;
		const len = bytes.byteLength;
		const inPtr = alloc(len);
		const outPtr = alloc(needed);
		try {
			memoryU8().set(bytes, inPtr);
			const decode = wasmExports() as unknown as {
				decompress_lz4(inPtr: number, inLen: number, outPtr: number, outLen: number): number;
			};
			const written = decode.decompress_lz4(inPtr, len, outPtr, needed);
			if (written < 0) throw new Error(`decompress_lz4 failed: ${written}`);
			return memoryU8().slice(outPtr, outPtr + written);
		} finally {
			free(inPtr, len);
			free(outPtr, needed);
		}
	}
}
