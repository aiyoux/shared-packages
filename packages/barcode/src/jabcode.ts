/// <reference path="./jabcode.d.ts" />
/**
 * JAB Code encode/decode wrapper.
 *
 * Uses a rebuilt Emscripten module (jabcodeModule.js) with embedded WASM.
 * The original prebuilt jabcodeJSLib.min.js was broken:
 *  - missing WASM binary (placeholder never substituted)
 *  - JS encode swapped color/symbol args vs C API
 *  - PNG packing used wrong layout / invalid PNGs
 *  - double-free on the encode buffer
 */

/** Supported module-color counts (powers of 2). 8 is the library default. */
export const JAB_COLOR_OPTIONS = [4, 8, 16, 32, 64, 128, 256] as const;
export type JabColorCount = (typeof JAB_COLOR_OPTIONS)[number];

type JabModule = {
	ccall: (name: string, returnType: string, argTypes: string[], args: unknown[]) => unknown;
	_free: (ptr: number) => void;
	_malloc: (size: number) => number;
	HEAPU8: Uint8Array;
	HEAP32: Int32Array;
};

let modulePromise: Promise<JabModule> | null = null;

export function normalizeJabColors(value: unknown): JabColorCount {
	const n = typeof value === 'number' ? value : parseInt(String(value), 10);
	if (JAB_COLOR_OPTIONS.includes(n as JabColorCount)) return n as JabColorCount;
	let best: JabColorCount = 8;
	let bestDist = Infinity;
	for (const c of JAB_COLOR_OPTIONS) {
		const d = Math.abs(c - (Number.isFinite(n) ? n : 8));
		if (d < bestDist) {
			bestDist = d;
			best = c;
		}
	}
	return best;
}

async function getModule(): Promise<JabModule> {
	if (typeof window === 'undefined') {
		throw new Error('JAB Code only runs in the browser');
	}
	if (!modulePromise) {
		modulePromise = (async () => {
			const { default: createJabcodeModule } = await import('./jabcodeModule.js');
			const mod = (await createJabcodeModule({
				print: () => {},
				printErr: (msg: string) => {
					if (typeof msg === 'string' && /JABCode|Error/i.test(msg)) {
						console.warn('[jabcode]', msg);
					}
				}
			})) as JabModule;
			return mod;
		})();
	}
	return modulePromise;
}

/**
 * C layout of encode_image return (jabcode_interface.c format_array):
 *   HEAP32[0] = pixel byte count
 *   HEAP32[1] = arg count (3)
 *   HEAP32[2] = width
 *   HEAP32[3] = height
 *   HEAP32[4] = color_number
 *   bytes from offset 20 = RGBA pixels
 *
 * C signature: encode_image(data, color_number, symbol_number)
 */
function bitmapToDataUrl(mod: JabModule, ptr: number): string | null {
	if (!ptr) return null;
	try {
		const width = mod.HEAP32[(ptr >> 2) + 2];
		const height = mod.HEAP32[(ptr >> 2) + 3];
		if (!(width > 0 && height > 0 && width < 8192 && height < 8192)) {
			return null;
		}
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		const img = ctx.createImageData(width, height);
		const pixelBase = ptr + 20;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const src = pixelBase + 4 * (y * width + x);
				const dst = 4 * (y * width + x);
				img.data[dst] = mod.HEAPU8[src];
				img.data[dst + 1] = mod.HEAPU8[src + 1];
				img.data[dst + 2] = mod.HEAPU8[src + 2];
				const a = mod.HEAPU8[src + 3];
				img.data[dst + 3] = a > 0 ? a : 255;
			}
		}
		ctx.putImageData(img, 0, 0);
		return canvas.toDataURL('image/png');
	} finally {
		mod._free(ptr);
	}
}

function dataUrlIsLoadableImage(dataUrl: string): Promise<boolean> {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0);
		img.onerror = () => resolve(false);
		img.src = dataUrl;
	});
}

/** Encode data as a JAB Code PNG data-URL. */
export async function generateJabCode(
	data: string,
	colorNumber?: number,
	symbolNumber?: number
): Promise<string | null> {
	const colors = normalizeJabColors(colorNumber);
	// Multi-symbol needs explicit positions not exposed by this API — use 1 symbol.
	const symbols =
		symbolNumber != null && Number(symbolNumber) >= 1
			? Math.min(61, Math.max(1, Math.floor(Number(symbolNumber))))
			: 1;

	try {
		const mod = await getModule();
		const ptr = mod.ccall(
			'encode_image',
			'number',
			['string', 'number', 'number'],
			[data, colors, symbols]
		) as number;
		if (!ptr) {
			console.warn(
				`[jabcode] encode null colors=${colors} symbols=${symbols} dataLen=${data.length}`
			);
			return null;
		}
		const dataUrl = bitmapToDataUrl(mod, ptr);
		if (!dataUrl) {
			console.warn(`[jabcode] bitmap convert failed colors=${colors}`);
			return null;
		}
		if (!(await dataUrlIsLoadableImage(dataUrl))) {
			console.warn(`[jabcode] unloadable PNG colors=${colors} len=${dataUrl.length}`);
			return null;
		}
		console.info(
			`[jabcode] encoded ok colors=${colors} symbols=${symbols} dataLen=${data.length}`
		);
		return dataUrl;
	} catch (err) {
		console.warn('[jabcode] generation failed:', err instanceof Error ? err.message : err);
		return null;
	}
}

/** Decode a JAB Code from a PNG/JPEG data-URL or image ArrayBuffer. */
export async function decodeJabCode(
	imageBase64OrArrayBuffer: string | ArrayBuffer
): Promise<string | null> {
	try {
		const mod = await getModule();
		const bytes = await imageToPngBytes(imageBase64OrArrayBuffer);
		if (!bytes || bytes.length === 0) return null;

		const inPtr = mod._malloc(bytes.length);
		mod.HEAPU8.set(bytes, inPtr);
		const resultPtr = mod.ccall(
			'decode_image',
			'number',
			['number', 'number'],
			[inPtr, bytes.length]
		) as number;
		mod._free(inPtr);

		if (!resultPtr) return null;
		try {
			const length = mod.HEAP32[resultPtr >> 2];
			if (length <= 0 || length > 1_000_000) return null;
			const out = new Uint8Array(length);
			out.set(mod.HEAPU8.subarray(resultPtr + 8, resultPtr + 8 + length));
			const text = new TextDecoder().decode(out);
			return text.length > 0 ? text : null;
		} finally {
			mod._free(resultPtr);
		}
	} catch (err) {
		console.warn('[jabcode] decode failed:', err instanceof Error ? err.message : err);
		return null;
	}
}

async function imageToPngBytes(image: string | ArrayBuffer): Promise<Uint8Array | null> {
	if (image instanceof ArrayBuffer) return new Uint8Array(image);
	if (typeof image !== 'string') return null;

	const marker = 'base64,';
	const idx = image.indexOf(marker);
	const b64 = idx >= 0 ? image.slice(idx + marker.length) : image;
	try {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}
