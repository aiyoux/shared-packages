import {
	engineInfo,
	type ArchiveEntry,
	type CompressOptions,
	type CompressionEngine,
	type UnzipProgressOpts
} from '../types.js';

type ZipJs = typeof import('@zip.js/zip.js');

let mod: ZipJs | null = null;
let configured = false;

async function get(): Promise<ZipJs> {
	if (!mod) mod = await import('@zip.js/zip.js');
	if (!configured) {
		mod.configure({
			useWebWorkers: false,
			useCompressionStream: true
		});
		configured = true;
	}
	return mod;
}

function levelOf(options?: CompressOptions): number {
	if (options?.level === 'speed') return 1;
	if (options?.level === 'ratio') return 9;
	return 5;
}

function asU8(data: unknown): Uint8Array | null {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		const v = data as ArrayBufferView;
		return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
	}
	return null;
}

export const zipjsEngine: CompressionEngine = {
	info: engineInfo('zipjs'),

	async load() {
		await get();
	},

	async compress(_bytes, codec) {
		throw new Error(`zip.js cannot single-file compress ${codec}`);
	},

	async decompress(_bytes, codec) {
		throw new Error(`zip.js cannot single-file decompress ${codec}`);
	},

	async zip(entries: ArchiveEntry[], options?: CompressOptions) {
		const z = await get();
		const writer = new z.ZipWriter(new z.Uint8ArrayWriter(), { level: levelOf(options) });
		for (const entry of entries) {
			const name = entry.name.replace(/^\/+/, '') || 'file';
			if (name.endsWith('/')) continue;
			await writer.add(name, new z.Uint8ArrayReader(entry.data), { level: levelOf(options) });
		}
		return writer.close();
	},

	async unzip(bytes: Uint8Array, opts?: UnzipProgressOpts) {
		const z = await get();
		const reader = new z.ZipReader(new z.Uint8ArrayReader(bytes), { signal: opts?.signal });
		const out: ArchiveEntry[] = [];
		try {
			const members = await reader.getEntries();
			for (const member of members) {
				if (opts?.signal?.aborted) {
					const e = new Error('Cancelled');
					e.name = 'AbortError';
					throw e;
				}
				const name = member.filename ?? '';
				if (!name || name.endsWith('/') || member.directory) continue;
				if (!('getData' in member) || typeof member.getData !== 'function') continue;
				opts?.onMember?.({
					name,
					transferred: 0,
					size: member.uncompressedSize,
					done: false
				});
				const raw = await member.getData(new z.Uint8ArrayWriter(), { signal: opts?.signal });
				const data = asU8(raw);
				if (!data) continue;
				const entry = { name, data };
				if (opts?.onEntry) await opts.onEntry(entry);
				else out.push(entry);
				opts?.onMember?.({
					name,
					transferred: data.byteLength,
					size: member.uncompressedSize ?? data.byteLength,
					done: true
				});
			}
		} finally {
			await reader.close();
		}
		return out;
	}
};
