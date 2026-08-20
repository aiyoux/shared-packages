/**
 * Packed RGBA ImageData for tracers.
 *
 * Decoders (jSquash PNG, canvas getImageData, wasm resize) often hand back an
 * ImageData whose `.data` is a view into a larger — sometimes resizable WASM —
 * ArrayBuffer. esm-potrace-wasm's cwrap `"array"` path does HEAP8.set(pixels),
 * which throws `RangeError: offset is out of bounds` on those views and on
 * images whose RGBA blob does not fit the module's heap.
 */

/** Stay under a typical 16 MiB potrace heap after stack/allocator overhead. */
export const MAX_POTRACE_PIXELS = 1_500_000;

export function isOffsetOutOfBounds(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /offset.*(?:out of bounds|outside)/i.test(msg) || /out of bounds/i.test(msg);
}

function makeImageData(data: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): ImageData {
	if (typeof ImageData === 'function') {
		try {
			return new ImageData(data, width, height);
		} catch {
			/* jsdom / incomplete ImageData */
		}
	}
	return { data, width, height } as ImageData;
}

function sample(src: ArrayLike<number>, width: number, height: number, x: number, y: number, channel: number): number {
	const i = (y * width + x) * 4 + channel;
	return i < src.length ? Number(src[i]) || 0 : channel === 3 ? 255 : 0;
}

/**
 * Copy pixels onto a fresh, non-resizable buffer. Downscale when `maxPixels`
 * is set so the packed RGBA fits potrace's WASM heap.
 */
export function packImageData(image: ImageData, maxPixels = Number.POSITIVE_INFINITY): ImageData {
	const width = Math.max(1, image.width | 0);
	const height = Math.max(1, image.height | 0);
	const src = image.data;
	let outW = width;
	let outH = height;
	const pixels = width * height;
	if (Number.isFinite(maxPixels) && pixels > maxPixels && maxPixels >= 1) {
		const scale = Math.sqrt(maxPixels / pixels);
		outW = Math.max(1, Math.floor(width * scale));
		outH = Math.max(1, Math.floor(height * scale));
		while (outW * outH > maxPixels) {
			if (outW >= outH && outW > 1) outW -= 1;
			else if (outH > 1) outH -= 1;
			else break;
		}
	}
	const dst = new Uint8ClampedArray(new ArrayBuffer(outW * outH * 4));
	if (outW === width && outH === height) {
		const n = Math.min(src.length, dst.length);
		try {
			dst.set(src.subarray(0, n));
		} catch {
			for (let i = 0; i < n; i++) dst[i] = src[i]!;
		}
		if (src.length < dst.length) {
			for (let i = src.length; i < dst.length; i += 4) dst[i + 3] = 255;
		}
		return makeImageData(dst, outW, outH);
	}
	for (let y = 0; y < outH; y++) {
		const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / outH));
		for (let x = 0; x < outW; x++) {
			const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / outW));
			const di = (y * outW + x) * 4;
			dst[di] = sample(src, width, height, sx, sy, 0);
			dst[di + 1] = sample(src, width, height, sx, sy, 1);
			dst[di + 2] = sample(src, width, height, sx, sy, 2);
			dst[di + 3] = sample(src, width, height, sx, sy, 3) || 255;
		}
	}
	return makeImageData(dst, outW, outH);
}
