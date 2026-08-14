/** Byte-level progress for streamed downloads. `total` may be unknown. */
export type ByteProgress = (transferred: number, total?: number) => void;

export type ReadProgressOpts = {
	onProgress?: ByteProgress;
	maxBytes?: number;
	contentType?: string;
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
	if (!res.body || typeof res.body.getReader !== 'function') {
		const blob = await res.blob();
		onProgress?.(blob.size, blob.size);
		return blob;
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
			chunks.push(value);
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
	return new Blob(chunks as BlobPart[], { type });
}
