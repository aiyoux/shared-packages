const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
	let c = i;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	CRC_TABLE[i] = c >>> 0;
}

function crc32(buf: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf: Uint8Array): number {
	let a = 1;
	let b = 0;
	for (let i = 0; i < buf.length; i++) {
		a = (a + buf[i]!) % 65521;
		b = (b + a) % 65521;
	}
	return ((b << 16) | a) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(8 + data.length + 4);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out[4] = type.charCodeAt(0);
	out[5] = type.charCodeAt(1);
	out[6] = type.charCodeAt(2);
	out[7] = type.charCodeAt(3);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

function zlibStore(data: Uint8Array): Uint8Array {
	const max = 65535;
	const blocks: Uint8Array[] = [];
	if (data.length === 0) {
		const empty = new Uint8Array(5);
		empty[0] = 1;
		blocks.push(empty);
	} else {
		for (let off = 0; off < data.length; off += max) {
			const slice = data.subarray(off, Math.min(off + max, data.length));
			const last = off + max >= data.length;
			const block = new Uint8Array(5 + slice.length);
			block[0] = last ? 1 : 0;
			block[1] = slice.length & 0xff;
			block[2] = (slice.length >> 8) & 0xff;
			const nlen = ~slice.length & 0xffff;
			block[3] = nlen & 0xff;
			block[4] = (nlen >> 8) & 0xff;
			block.set(slice, 5);
			blocks.push(block);
		}
	}
	const bodyLen = blocks.reduce((n, b) => n + b.length, 0);
	const out = new Uint8Array(2 + bodyLen + 4);
	out[0] = 0x78;
	out[1] = 0x01;
	let p = 2;
	for (const b of blocks) {
		out.set(b, p);
		p += b.length;
	}
	new DataView(out.buffer).setUint32(p, adler32(data));
	return out;
}

export function encodePngRgba(width: number, height: number, rgba: Uint8Array): Uint8Array {
	const stride = width * 4;
	const raw = new Uint8Array((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		const o = y * (stride + 1);
		raw[o] = 0;
		raw.set(rgba.subarray(y * stride, y * stride + stride), o + 1);
	}
	const ihdr = new Uint8Array(13);
	const v = new DataView(ihdr.buffer);
	v.setUint32(0, width);
	v.setUint32(4, height);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
	const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', zlibStore(raw)), chunk('IEND', new Uint8Array(0))];
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

export function bytesToDataUrl(mime: string, bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	const parts: string[] = [];
	for (let i = 0; i < bytes.length; i += CHUNK) {
		parts.push(String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length))));
	}
	return `data:${mime};base64,${btoa(parts.join(''))}`;
}

/** pdf.js ImageKind: GRAYSCALE_1BPP = 1, RGB_24BPP = 2, RGBA_32BPP = 3 */
export function imageDataToRgba(img: {
	width: number;
	height: number;
	kind?: number;
	data?: Uint8Array | Uint8ClampedArray | number[];
}): Uint8Array | null {
	const { width, height, data } = img;
	if (!data || !width || !height) return null;
	const n = width * height;
	const src = data instanceof Uint8Array || data instanceof Uint8ClampedArray ? data : Uint8Array.from(data);
	const rgba = new Uint8Array(n * 4);
	const kind = img.kind ?? (src.length >= n * 4 ? 3 : src.length >= n * 3 ? 2 : 1);
	if (kind === 3 || src.length >= n * 4) {
		rgba.set(src.subarray(0, n * 4));
		return rgba;
	}
	if (kind === 2 || src.length >= n * 3) {
		for (let i = 0, j = 0; i < n; i++, j += 3) {
			const o = i * 4;
			rgba[o] = src[j]!;
			rgba[o + 1] = src[j + 1]!;
			rgba[o + 2] = src[j + 2]!;
			rgba[o + 3] = 255;
		}
		return rgba;
	}
	const rowBytes = Math.ceil(width / 8);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const byte = src[y * rowBytes + (x >> 3)] ?? 0;
			const bit = (byte >> (7 - (x & 7))) & 1;
			const v = bit ? 0 : 255;
			const o = (y * width + x) * 4;
			rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
			rgba[o + 3] = 255;
		}
	}
	return rgba;
}

export function rasterToPngDataUrl(img: {
	width: number;
	height: number;
	kind?: number;
	data?: Uint8Array | Uint8ClampedArray | number[];
}): string | null {
	const rgba = imageDataToRgba(img);
	if (!rgba) return null;
	return bytesToDataUrl('image/png', encodePngRgba(img.width, img.height, rgba));
}
