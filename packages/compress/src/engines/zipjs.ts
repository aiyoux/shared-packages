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

function abortIf(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const e = new Error('Cancelled');
	e.name = 'AbortError';
	throw e;
}

function profileAdd(name: string, ms: number): void {
	(globalThis as { __VFS_PROFILE_ADD__?: (n: string, ms: number) => void }).__VFS_PROFILE_ADD__?.(
		name,
		ms
	);
}

/**
 * fflate's unzipSync is one tight loop (the 50MB nested stored zip was 47ms).
 * zip.js `getData` per member is ~1ms of async overhead × thousands of files.
 * Encrypted / Zip64 / odd method zips throw and we fall back to zip.js.
 */
async function unzipSyncAll(bytes: Uint8Array, opts?: UnzipProgressOpts): Promise<ArchiveEntry[]> {
	const fflate = await import('fflate');
	abortIf(opts?.signal);
	const t0 = performance.now();
	// Worker unzip beats unzipSync on many deflated members (2–5× in-process).
	const tree = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
		const term = fflate.unzip(bytes, (err, data) => (err ? reject(err) : resolve(data)));
		const onAbort = () => {
			term();
			const e = new Error('Cancelled');
			e.name = 'AbortError';
			reject(e);
		};
		if (opts?.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener('abort', onAbort, { once: true });
		}
	}).catch((err: unknown) => {
		if ((err as Error)?.name === 'AbortError') throw err;
		return fflate.unzipSync(bytes);
	});
	profileAdd('zipjs.inflate', performance.now() - t0);
	const out: ArchiveEntry[] = [];
	for (const [name, data] of Object.entries(tree)) {
		abortIf(opts?.signal);
		if (!name || name.endsWith('/')) continue;
		out.push({ name, data });
	}
	return out;
}

async function unzipViaZipJs(bytes: Uint8Array, opts?: UnzipProgressOpts): Promise<ArchiveEntry[]> {
	const z = await get();
	const reader = new z.ZipReader(new z.Uint8ArrayReader(bytes), { signal: opts?.signal });
	const out: ArchiveEntry[] = [];
	try {
		const tEntries = performance.now();
		const members = await reader.getEntries();
		profileAdd('zipjs.getEntries', performance.now() - tEntries);
		const tInflate = performance.now();
		for (const member of members) {
			abortIf(opts?.signal);
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
			out.push({ name, data });
			opts?.onMember?.({
				name,
				transferred: data.byteLength,
				size: member.uncompressedSize ?? data.byteLength,
				done: true
			});
		}
		profileAdd('zipjs.inflate', performance.now() - tInflate);
	} finally {
		await reader.close();
	}
	return out;
}

async function deliver(files: ArchiveEntry[], opts?: UnzipProgressOpts): Promise<ArchiveEntry[]> {
	if (!opts?.onEntry) return files;
	const tEntry = performance.now();
	for (const entry of files) {
		abortIf(opts.signal);
		await opts.onEntry(entry);
	}
	profileAdd('zipjs.onEntry', performance.now() - tEntry);
	return [];
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
		let files: ArchiveEntry[];
		try {
			files = await unzipSyncAll(bytes, opts);
		} catch {
			files = await unzipViaZipJs(bytes, opts);
		}
		return deliver(files, opts);
	}
};
