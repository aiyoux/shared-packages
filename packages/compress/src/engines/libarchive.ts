import {
	engineInfo,
	type ArchiveEntry,
	type CompressionEngine,
	type UnzipProgressOpts
} from '../types.js';

type LibarchiveMod = typeof import('libarchive-wasm');
type LibarchiveWasm = Awaited<ReturnType<LibarchiveMod['libarchiveWasm']>>;

let api: LibarchiveMod | null = null;
let wasm: LibarchiveWasm | null = null;

function asU8(data: unknown): Uint8Array | null {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		const v = data as ArrayBufferView;
		return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
	}
	return null;
}

function asI8(bytes: Uint8Array): Int8Array {
	return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Browser: fetch the vendored wasm. Node tests: let emscripten read dist/. */
async function wasmInitOpts(): Promise<object | undefined> {
	if (typeof document === 'undefined') return undefined;
	const res = await fetch('/vendor/libarchive.wasm');
	if (!res.ok) {
		throw new Error(`libarchive.wasm HTTP ${res.status} — copy it to /vendor (hub prepare)`);
	}
	return { wasmBinary: new Uint8Array(await res.arrayBuffer()) };
}

async function getWasm(): Promise<{ api: LibarchiveMod; wasm: LibarchiveWasm }> {
	if (!api) api = await import('libarchive-wasm');
	if (!wasm) wasm = await api.libarchiveWasm(await wasmInitOpts());
	return { api, wasm };
}

async function extract(bytes: Uint8Array, opts?: UnzipProgressOpts): Promise<ArchiveEntry[]> {
	const { api: lib, wasm: mod } = await getWasm();
	const reader = new lib.ArchiveReader(mod, asI8(bytes));
	const out: ArchiveEntry[] = [];
	try {
		for (const member of reader.entries()) {
			if (opts?.signal?.aborted) {
				const e = new Error('Cancelled');
				e.name = 'AbortError';
				throw e;
			}
			const name = member.getPathname() || '';
			if (!name || name.endsWith('/') || member.getFiletype() !== 'File') {
				member.skipData();
				continue;
			}
			if (member.isEncrypted()) {
				throw new Error(`Encrypted archive member: ${name}`);
			}
			const size = member.getSize();
			opts?.onMember?.({ name, transferred: 0, size, done: false });
			const raw = member.readData();
			const data = raw ? asU8(raw) ?? new Uint8Array(0) : new Uint8Array(0);
			const entry = { name, data };
			if (opts?.onEntry) await opts.onEntry(entry);
			else out.push(entry);
			opts?.onMember?.({
				name,
				transferred: data.byteLength,
				size: size || data.byteLength,
				done: true
			});
			await new Promise((r) => setTimeout(r, 0));
		}
	} finally {
		reader.free();
	}
	return out;
}

export const libarchiveEngine: CompressionEngine = {
	info: engineInfo('libarchive'),

	async load() {
		await getWasm();
	},

	async compress(_bytes, codec) {
		throw new Error(`libarchive cannot create ${codec}`);
	},

	async decompress(_bytes, codec) {
		throw new Error(`libarchive cannot expand ${codec} as a single stream`);
	},

	async unzip(bytes, opts) {
		return extract(bytes, opts);
	},

	async untar(bytes) {
		return extract(bytes);
	},

	async unarchive(bytes, opts) {
		return extract(bytes, opts);
	}
};
