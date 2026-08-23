import { engineInfo, type ArchiveEntry, type CompressOptions, type CompressionEngine } from '../types.js';

type NanotarMod = typeof import('nanotar');

let mod: NanotarMod | null = null;

async function get(): Promise<NanotarMod> {
	if (!mod) mod = await import('nanotar');
	return mod;
}

export const nanotarEngine: CompressionEngine = {
	info: engineInfo('nanotar'),

	async load() {
		await get();
	},

	async compress(_bytes, codec) {
		throw new Error(`nanotar cannot single-file compress ${codec}`);
	},

	async decompress(_bytes, codec) {
		throw new Error(`nanotar cannot single-file decompress ${codec}`);
	},

	async tar(entries: ArchiveEntry[], _options?: CompressOptions) {
		const { createTar } = await get();
		const items = entries
			.filter((e) => e.name && !e.name.endsWith('/'))
			.map((e) => ({
				name: e.name.replace(/^\/+/, '') || 'file',
				data: e.data
			}));
		return createTar(items);
	},

	async untar(bytes: Uint8Array) {
		const { parseTar } = await get();
		const files = parseTar(bytes);
		const out: ArchiveEntry[] = [];
		for (const file of files) {
			if (!file.name || file.name.endsWith('/')) continue;
			if (!file.data) continue;
			out.push({ name: file.name, data: file.data });
		}
		return out;
	}
};
