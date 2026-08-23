import { engineInfo, type ArchiveEntry, type CompressOptions, type CompressionEngine } from '../types.js';

type TarjsMod = typeof import('@gera2ld/tarjs');

let mod: TarjsMod | null = null;

async function get(): Promise<TarjsMod> {
	if (!mod) mod = await import('@gera2ld/tarjs');
	return mod;
}

export const tarjsEngine: CompressionEngine = {
	info: engineInfo('tarjs'),

	async load() {
		await get();
	},

	async compress(_bytes, codec) {
		throw new Error(`tarjs cannot single-file compress ${codec}`);
	},

	async decompress(_bytes, codec) {
		throw new Error(`tarjs cannot single-file decompress ${codec}`);
	},

	async tar(entries: ArchiveEntry[], _options?: CompressOptions) {
		const { TarWriter } = await get();
		const w = new TarWriter();
		for (const entry of entries) {
			const name = entry.name.replace(/^\/+/, '') || 'file';
			if (name.endsWith('/')) continue;
			w.addFile(name, entry.data);
		}
		const blob = await w.write();
		return new Uint8Array(await blob.arrayBuffer());
	},

	async untar(bytes: Uint8Array) {
		const { TarReader } = await get();
		const blob = new Blob([bytes as BlobPart]);
		const reader = await TarReader.load(blob);
		const out: ArchiveEntry[] = [];
		for (const info of reader.fileInfos) {
			if (!info.name || info.name.endsWith('/')) continue;
			// type 0 = regular file; skip directories/symlinks/etc.
			if (info.type !== 0) continue;
			const fileBlob = reader.getFileBlob(info.name);
			if (!fileBlob) continue;
			const data = new Uint8Array(await fileBlob.arrayBuffer());
			out.push({ name: info.name, data });
		}
		return out;
	}
};
