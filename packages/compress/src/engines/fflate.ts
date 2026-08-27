import {
	engineInfo,
	type ArchiveEntry,
	type CompressOptions,
	type CompressionEngine,
	type UnzipProgressOpts
} from '../types.js';

type Fflate = typeof import('fflate');

let mod: Fflate | null = null;

async function get(): Promise<Fflate> {
	if (!mod) mod = await import('fflate');
	return mod;
}

function asU8(data: Uint8Array): Uint8Array {
	return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
	const len = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(len);
	let o = 0;
	for (const c of chunks) {
		out.set(c, o);
		o += c.length;
	}
	return out;
}

function flateAsync(
	fn: (data: Uint8Array, cb: (err: Error | null, data: Uint8Array) => void) => void,
	data: Uint8Array
): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		fn(data, (err, out) => (err ? reject(err) : resolve(out)));
	});
}

export const fflateEngine: CompressionEngine = {
	info: engineInfo('fflate'),

	async load() {
		await get();
	},

	async compress(bytes, codec) {
		const f = await get();
		const input = asU8(bytes);
		if (codec === 'gzip') return flateAsync(f.gzip, input);
		if (codec === 'deflate') return flateAsync(f.deflate, input);
		if (codec === 'zlib') return flateAsync(f.zlib, input);
		throw new Error(`fflate cannot compress ${codec}`);
	},

	async decompress(bytes, codec) {
		const f = await get();
		const input = asU8(bytes);
		if (codec === 'gzip') return flateAsync(f.gunzip, input);
		if (codec === 'deflate') return flateAsync(f.inflate, input);
		if (codec === 'zlib') return flateAsync(f.unzlib, input);
		throw new Error(`fflate cannot expand ${codec}`);
	},

	async zip(entries: ArchiveEntry[], _options?: CompressOptions) {
		const f = await get();
		const tree: import('fflate').AsyncZippable = {};
		for (const entry of entries) {
			const name = entry.name.replace(/^\/+/, '') || 'file';
			if (name.endsWith('/')) continue;
			tree[name] = asU8(entry.data);
		}
		return new Promise<Uint8Array>((resolve, reject) => {
			f.zip(tree, (err, data) => (err ? reject(err) : resolve(data)));
		});
	},

	async unzip(bytes: Uint8Array, opts?: UnzipProgressOpts) {
		const f = await get();
		const input = asU8(bytes);
		type Pending = { name: string; size?: number; data: Promise<Uint8Array> };
		const pending: Pending[] = [];
		try {
			await new Promise<void>((resolve, reject) => {
				const uz = new f.Unzip((file) => {
					if (!file.name || file.name.endsWith('/')) return;
					pending.push({
						name: file.name,
						size: file.originalSize,
						data: new Promise<Uint8Array>((res, rej) => {
							const chunks: Uint8Array[] = [];
							file.ondata = (err, data, final) => {
								if (err) {
									rej(err);
									return;
								}
								if (data?.byteLength) chunks.push(data);
								if (final) res(concatChunks(chunks));
							};
							try {
								file.start();
							} catch (e) {
								rej(e instanceof Error ? e : new Error(String(e)));
							}
						})
					});
				});
				uz.register(f.UnzipPassThrough);
				uz.register(f.UnzipInflate);
				try {
					uz.push(input, true);
					resolve();
				} catch (e) {
					reject(e);
				}
			});
			if (!pending.length) throw new Error('empty zip');
			const out: ArchiveEntry[] = [];
			for (const p of pending) {
				opts?.onMember?.({
					name: p.name,
					transferred: 0,
					size: p.size,
					done: false
				});
				const data = await p.data;
				out.push({ name: p.name, data });
				opts?.onMember?.({
					name: p.name,
					transferred: data.byteLength,
					size: p.size ?? data.byteLength,
					done: true
				});
				await new Promise((r) => setTimeout(r, 0));
			}
			return out;
		} catch {
			const tree = f.unzipSync(input);
			const out: ArchiveEntry[] = [];
			for (const [name, data] of Object.entries(tree)) {
				if (!name || name.endsWith('/')) continue;
				out.push({ name, data });
				opts?.onMember?.({
					name,
					transferred: data.byteLength,
					size: data.byteLength,
					done: true
				});
				// unzipSync is fully synchronous — yield so each member tick can
				// paint and pending UI work (cancel, progress) can run between.
				await new Promise((r) => setTimeout(r, 0));
			}
			return out;
		}
	}
};
