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

type ByteTransform = {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<BufferSource>;
};

/**
 * Push `bytes` through a native transform and collect the result.
 *
 * Read concurrently. Chromium deadlocks if we write+close first: the
 * transform's internal buffer fills and close() never settles.
 *
 * When the transform errors — corrupt input to a DecompressionStream is the
 * common case — the readable side and the writer BOTH reject. Awaiting only
 * one leaves the other an unhandled rejection: in Node that fails the run
 * outright, and in the browser it fires `unhandledrejection` for every bad
 * frame the /cm camera scanner gates through `isAcceptableScanText`. So
 * settle both sides, then surface the readable's error, which carries the
 * underlying zlib cause (`Z_DATA_ERROR`).
 */
async function pumpBytes(transform: ByteTransform, bytes: Uint8Array): Promise<Uint8Array> {
	const readerP = readStreamToBytes(transform.readable);
	const writerP = (async () => {
		const writer = transform.writable.getWriter();
		await writer.write(asWriteView(bytes));
		await writer.close();
	})();

	const [read, written] = await Promise.allSettled([readerP, writerP]);
	if (read.status === 'rejected') throw read.reason;
	if (written.status === 'rejected') throw written.reason;
	return read.value;
}

export function compressBytes(bytes: Uint8Array, format: NativeStreamCodec): Promise<Uint8Array> {
	return pumpBytes(new CompressionStream(format), bytes);
}

export function decompressBytes(bytes: Uint8Array, format: NativeStreamCodec): Promise<Uint8Array> {
	return pumpBytes(new DecompressionStream(format), bytes);
}

export const deflateRaw = (bytes: Uint8Array) => compressBytes(bytes, 'deflate-raw');
export const inflateRaw = (bytes: Uint8Array) => decompressBytes(bytes, 'deflate-raw');
export const gzipBytes = (bytes: Uint8Array) => compressBytes(bytes, 'gzip');
export const gunzipBytes = (bytes: Uint8Array) => decompressBytes(bytes, 'gzip');
