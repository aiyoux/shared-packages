/** Byte-level progress for streamed downloads. `total` may be unknown. */
export type ByteProgress = (transferred: number, total?: number) => void;

export type ReadProgressOpts = {
	onProgress?: ByteProgress;
	maxBytes?: number;
	contentType?: string;
	/** Called for each body chunk (awaited, so the reader can apply backpressure). */
	onChunk?: (chunk: Uint8Array) => void | Promise<void>;
	/**
	 * When false, do not retain chunks for the returned Blob (empty Blob).
	 * Use with `onChunk` when the caller consumes bytes as they arrive.
	 */
	assemble?: boolean;
};

/**
 * Read a fetch Response as a Blob, emitting throttled byte progress.
 * Falls back to `res.blob()` when the body is not readable.
 */
export async function blobFromResponse(res: Response, opts?: ReadProgressOpts): Promise<Blob> {
	const totalHeader = Number(res.headers.get('content-length') || '') || undefined;
	const type =
		opts?.contentType || res.headers.get('content-type') || 'application/octet-stream';
	const onProgress = opts?.onProgress;
	const assemble = opts?.assemble !== false;
	if (!res.body || typeof res.body.getReader !== 'function') {
		const blob = await res.blob();
		if (opts?.onChunk && blob.size) {
			await emitBlobChunks(blob, { onChunk: opts.onChunk, onProgress });
		} else {
			onProgress?.(blob.size, blob.size);
		}
		return assemble ? blob : new Blob([], { type });
	}
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let transferred = 0;
	let lastEmit = 0;
	const emit = (force = false) => {
		const now = Date.now();
		if (!force && lastEmit && now - lastEmit < 80) return;
		lastEmit = now;
		onProgress?.(transferred, totalHeader);
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			transferred += value.byteLength;
			if (opts?.maxBytes != null && transferred > opts.maxBytes) {
				await reader.cancel();
				throw new Error('EXPLORER_TOO_LARGE');
			}
			if (assemble) chunks.push(value);
			await opts?.onChunk?.(value);
			emit();
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			/* already cancelled */
		}
	}
	onProgress?.(transferred, totalHeader ?? transferred);
	return assemble ? new Blob(chunks as BlobPart[], { type }) : new Blob([], { type });
}

/** Slice a Blob into chunks, awaiting `onChunk` so callers can apply backpressure. */
export async function emitBlobChunks(
	blob: Blob,
	opts: {
		onChunk: (chunk: Uint8Array) => void | Promise<void>;
		onProgress?: ByteProgress;
		chunkSize?: number;
	}
): Promise<void> {
	const step = Math.max(16 * 1024, opts.chunkSize ?? 64 * 1024);
	const total = blob.size;
	for (let offset = 0; offset < total; offset += step) {
		const end = Math.min(offset + step, total);
		const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
		await opts.onChunk(chunk);
		opts.onProgress?.(end, total);
	}
}
