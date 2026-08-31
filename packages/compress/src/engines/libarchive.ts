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

const VENDOR_WASM = '/vendor/libarchive.wasm';

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

/** Node tests read dist/libarchive.wasm via emscripten. Browser/worker fetch /vendor. */
function isNodeRuntime(): boolean {
	return (
		typeof process !== 'undefined' &&
		typeof process.versions?.node === 'string' &&
		typeof window === 'undefined' &&
		typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope === 'undefined'
	);
}

function isWasmBinary(bytes: Uint8Array): boolean {
	return bytes.byteLength >= 8 && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;
}

async function loadVendorWasm(): Promise<Uint8Array> {
	const res = await fetch(VENDOR_WASM);
	if (!res.ok) {
		throw new Error(`libarchive.wasm HTTP ${res.status} at ${VENDOR_WASM} — hub prepare copies it`);
	}
	const bytes = new Uint8Array(await res.arrayBuffer());
	if (!isWasmBinary(bytes)) {
		throw new Error(
			`libarchive.wasm is empty or not a wasm binary (${bytes.byteLength} bytes from ${VENDOR_WASM})`
		);
	}
	return bytes;
}

type EmscriptenOpts = {
	wasmBinary: Uint8Array;
	locateFile: (file: string) => string;
	instantiateWasm: (
		imports: WebAssembly.Imports,
		onSuccess: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
	) => { then: Promise<WebAssembly.Exports>['then'] };
};

async function wasmInitOpts(): Promise<EmscriptenOpts | undefined> {
	if (isNodeRuntime()) return undefined;
	const wasmBinary = await loadVendorWasm();
	return {
		wasmBinary,
		locateFile: (file) => (file.endsWith('.wasm') ? VENDOR_WASM : file),
		// Bypass emscripten's locateFile/fs path. Vite workers have no
		// `document`, and a Node process polyfill makes the glue read an
		// empty buffer ("BufferSource argument is empty").
		instantiateWasm(imports, onSuccess) {
			const done = WebAssembly.compile(wasmBinary as BufferSource).then((module) =>
				WebAssembly.instantiate(module, imports).then((instance) => {
					onSuccess(instance, module);
					return instance.exports;
				})
			);
			return done;
		}
	};
}

async function boot(mod: LibarchiveMod, opts: EmscriptenOpts | undefined): Promise<LibarchiveWasm> {
	const init = opts as Parameters<LibarchiveMod['libarchive']>[0];
	if (opts && typeof mod.libarchive === 'function') {
		return mod.wrapLibarchiveWasm(await mod.libarchive(init));
	}
	return mod.libarchiveWasm(init);
}

async function getWasm(): Promise<{ api: LibarchiveMod; wasm: LibarchiveWasm }> {
	if (!api) api = await import('libarchive-wasm');
	if (!wasm) wasm = await boot(api, await wasmInitOpts());
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
