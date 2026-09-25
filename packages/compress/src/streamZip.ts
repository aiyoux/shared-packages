/** ZIP64 writer for archives too large to fit in one JavaScript ArrayBuffer. */
export async function streamZip(
	entries: AsyncIterable<{ name: string; blob: Blob }>,
	writable: WritableStream<Uint8Array>,
	opts?: {
		signal?: AbortSignal;
		onProgress?: (name: string, transferred: number, size: number) => void;
	}
): Promise<void> {
	const { BlobReader, ZipWriter } = await import('@zip.js/zip.js');
	const writer = new ZipWriter(writable, {
		zip64: true,
		useWebWorkers: false,
		useCompressionStream: true
	});
	for await (const { name, blob } of entries) {
		if (opts?.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
		await writer.add(name, new BlobReader(blob), {
			zip64: true,
			signal: opts?.signal,
			onprogress: (transferred, size) => opts?.onProgress?.(name, transferred, size)
		});
	}
	if (opts?.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
	await writer.close();
}
