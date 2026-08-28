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
		// Declared outside the try: the catch needs to know whether a streaming
		// consumer already received members before falling back.
		let delivered = 0;
		try {
			let received = 0; // members whose final chunk has arrived (in order)
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
							if (final) {
								received += 1;
								res(concatChunks(chunks));
							}
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
			const out: ArchiveEntry[] = [];
			let next = 0;
			// Members 0..received-1 have all chunks in (fflate finishes members
			// in order), so their data promises resolve without further push.
			const settle = async () => {
				while (next < received && next < pending.length) {
					const p = pending[next++]!;
					opts?.onMember?.({ name: p.name, transferred: 0, size: p.size, done: false });
					const data = await p.data;
					// Streaming: hand the member off and drop our reference, so
					// peak memory is the consumer's window rather than the whole
					// archive. Awaiting also lets a slow writer throttle inflate.
					if (opts?.onEntry) await opts.onEntry({ name: p.name, data });
					else out.push({ name: p.name, data });
					delivered += 1;
					pending[next - 1] = undefined as unknown as Pending;
					opts?.onMember?.({
						name: p.name,
						transferred: data.byteLength,
						size: p.size ?? data.byteLength,
						done: true
					});
				}
			};
			// Push in ~2 MB slices and breathe between them. One giant push
			// inflates the whole archive inside a single frozen burst — no
			// progress, no cancel — and replaying per-member setTimeout yields
			// afterwards cost seconds on thousand-member archives (~1.2 ms each).
			// Slicing gives real per-member ticks during inflate at ~1 tick per
			// slice instead of per member.
			const SLICE = 1 << 21;
			for (let off = 0; off < input.length; off += SLICE) {
				const end = Math.min(off + SLICE, input.length);
				uz.push(input.subarray(off, end), end >= input.length);
				await settle();
				if (end < input.length) await new Promise((r) => setTimeout(r, 0));
			}
			await settle();
			// `out` stays empty when streaming, so count deliveries instead.
			if (!delivered) throw new Error('empty zip');
			return out;
		} catch (err) {
			// Members never awaited above must not surface as unhandled
			// rejections once we fall back.
			for (const p of pending) p?.data.catch(() => {});
			// The fallback re-parses from byte zero. If a streaming consumer has
			// already taken members, replaying them would deliver duplicates —
			// so once anything is handed off, the error is final.
			if (delivered) throw err;
			const tree = f.unzipSync(input);
			const out: ArchiveEntry[] = [];
			let i = 0;
			for (const [name, data] of Object.entries(tree)) {
				if (!name || name.endsWith('/')) continue;
				if (opts?.onEntry) await opts.onEntry({ name, data });
				else out.push({ name, data });
				opts?.onMember?.({
					name,
					transferred: data.byteLength,
					size: data.byteLength,
					done: true
				});
				// unzipSync is fully synchronous — yield every 16 members so ticks
				// can paint and cancel can run without paying a macrotask delay
				// per member (thousand-member archives spent seconds in yields).
				if ((++i & 15) === 0) await new Promise((r) => setTimeout(r, 0));
			}
			return out;
		}
	}
};
