export type NativeStreamCodec = 'deflate-raw' | 'deflate' | 'gzip';

export async function readStreamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) chunks.push(value);
	}
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const chunk of chunks) {
		out.set(chunk, off);
		off += chunk.length;
	}
	return out;
}

function asWriteView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

export async function compressBytes(
	bytes: Uint8Array,
	format: NativeStreamCodec
): Promise<Uint8Array> {
	const cs = new CompressionStream(format);
	const writer = cs.writable.getWriter();
	await writer.write(asWriteView(bytes));
	await writer.close();
	return readStreamToBytes(cs.readable);
}

export async function decompressBytes(
	bytes: Uint8Array,
	format: NativeStreamCodec
): Promise<Uint8Array> {
	const ds = new DecompressionStream(format);
	const writer = ds.writable.getWriter();
	await writer.write(asWriteView(bytes));
	await writer.close();
	return readStreamToBytes(ds.readable);
}

export const deflateRaw = (bytes: Uint8Array) => compressBytes(bytes, 'deflate-raw');
export const inflateRaw = (bytes: Uint8Array) => decompressBytes(bytes, 'deflate-raw');
export const gzipBytes = (bytes: Uint8Array) => compressBytes(bytes, 'gzip');
export const gunzipBytes = (bytes: Uint8Array) => decompressBytes(bytes, 'gzip');
