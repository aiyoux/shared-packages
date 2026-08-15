/**
 * Incremental SHA-256 plus Blob/File helpers.
 *
 * Web Crypto has no incremental digest, so large inputs use a small JS
 * implementation that consumes slices. That keeps us from materialising a
 * second full copy of a file just to hash it, and yields between slices so
 * the tab stays responsive. Small inputs still take SubtleCrypto.
 */
import { bytesToHex } from './hex.js';

/**
 * Above this, hash incrementally instead of buffering the whole input.
 * SubtleCrypto is ~10x faster, so the threshold is the largest transient
 * allocation we are willing to make to stay on the native path.
 */
export const SUBTLE_DIGEST_MAX_BYTES = 128 * 1024 * 1024;
/** Slice size when streaming a Blob/File through the incremental hasher. */
export const HASH_SLICE_BYTES = 4 * 1024 * 1024;

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

export class Sha256 {
	private h = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
	]);
	private readonly w = new Uint32Array(64);
	private readonly tail = new Uint8Array(64);
	private tailLen = 0;
	private totalBytes = 0;
	private finished = false;

	update(data: Uint8Array): this {
		if (this.finished) throw new Error('Sha256: update after digest');
		this.totalBytes += data.length;
		let off = 0;

		if (this.tailLen > 0) {
			const take = Math.min(64 - this.tailLen, data.length);
			this.tail.set(data.subarray(0, take), this.tailLen);
			this.tailLen += take;
			off = take;
			if (this.tailLen === 64) {
				this.block(this.tail, 0);
				this.tailLen = 0;
			}
		}

		while (off + 64 <= data.length) {
			this.block(data, off);
			off += 64;
		}

		if (off < data.length) {
			this.tail.set(data.subarray(off), 0);
			this.tailLen = data.length - off;
		}
		return this;
	}

	digest(): Uint8Array {
		if (this.finished) throw new Error('Sha256: digest called twice');
		this.finished = true;

		const hiBits = Math.floor(this.totalBytes / 0x20000000);
		const loBits = (this.totalBytes * 8) >>> 0;

		const pad = new Uint8Array(this.tailLen < 56 ? 64 : 128);
		pad.set(this.tail.subarray(0, this.tailLen), 0);
		pad[this.tailLen] = 0x80;
		const view = new DataView(pad.buffer);
		view.setUint32(pad.length - 8, hiBits, false);
		view.setUint32(pad.length - 4, loBits, false);
		for (let i = 0; i < pad.length; i += 64) this.block(pad, i);

		const out = new Uint8Array(32);
		const outView = new DataView(out.buffer);
		for (let i = 0; i < 8; i++) outView.setUint32(i * 4, this.h[i]!, false);
		return out;
	}

	digestHex(): string {
		return bytesToHex(this.digest());
	}

	private block(p: Uint8Array, off: number): void {
		const w = this.w;
		for (let i = 0; i < 16; i++) {
			const j = off + i * 4;
			w[i] = ((p[j]! << 24) | (p[j + 1]! << 16) | (p[j + 2]! << 8) | p[j + 3]!) >>> 0;
		}
		for (let i = 16; i < 64; i++) {
			const x = w[i - 15]!;
			const y = w[i - 2]!;
			const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
			const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
			w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
		}

		let a = this.h[0]!;
		let b = this.h[1]!;
		let c = this.h[2]!;
		let d = this.h[3]!;
		let e = this.h[4]!;
		let f = this.h[5]!;
		let g = this.h[6]!;
		let h = this.h[7]!;

		for (let i = 0; i < 64; i++) {
			const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
			const ch = (e & f) ^ (~e & g);
			const t1 = (h + S1 + ch + K[i]! + w[i]!) | 0;
			const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + maj) | 0;

			h = g;
			g = f;
			f = e;
			e = (d + t1) | 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) | 0;
		}

		this.h[0] = (this.h[0]! + a) | 0;
		this.h[1] = (this.h[1]! + b) | 0;
		this.h[2] = (this.h[2]! + c) | 0;
		this.h[3] = (this.h[3]! + d) | 0;
		this.h[4] = (this.h[4]! + e) | 0;
		this.h[5] = (this.h[5]! + f) | 0;
		this.h[6] = (this.h[6]! + g) | 0;
		this.h[7] = (this.h[7]! + h) | 0;
	}
}

export function createSha256(): Sha256 {
	return new Sha256();
}

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

function asDigestSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

export async function sha256Chunks(
	chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
	onProgress?: (hashed: number) => void
): Promise<string> {
	if (Array.isArray(chunks)) {
		const parts = chunks as Uint8Array[];
		let total = 0;
		for (const part of parts) total += part.byteLength;
		if (total <= SUBTLE_DIGEST_MAX_BYTES) {
			const joined = new Uint8Array(total);
			let at = 0;
			for (const part of parts) {
				joined.set(part, at);
				at += part.byteLength;
			}
			onProgress?.(total);
			return bytesToHex(await crypto.subtle.digest('SHA-256', joined));
		}
	}

	const hasher = createSha256();
	let hashed = 0;
	let sinceYield = 0;
	for await (const chunk of chunks as AsyncIterable<Uint8Array>) {
		hasher.update(chunk);
		hashed += chunk.byteLength;
		sinceYield += chunk.byteLength;
		onProgress?.(hashed);
		if (sinceYield >= HASH_SLICE_BYTES) {
			sinceYield = 0;
			await yieldToEventLoop();
		}
	}
	return hasher.digestHex();
}

export async function sha256BlobStreaming(
	blob: Blob,
	chunkSize = HASH_SLICE_BYTES,
	onProgress?: (hashed: number, total: number) => void
): Promise<string> {
	const size = blob.size;
	const step = Math.max(64 * 1024, chunkSize);
	const hasher = createSha256();
	onProgress?.(0, size);
	for (let offset = 0; offset < size; offset += step) {
		const end = Math.min(offset + step, size);
		const slice = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
		hasher.update(slice);
		onProgress?.(end, size);
		if (end < size) await yieldToEventLoop();
	}
	return hasher.digestHex();
}

export async function sha256Blob(blob: Blob): Promise<string> {
	if (blob.size <= SUBTLE_DIGEST_MAX_BYTES) {
		const buf = await blob.arrayBuffer();
		return bytesToHex(await crypto.subtle.digest('SHA-256', buf));
	}
	return sha256BlobStreaming(blob);
}

export async function sha256FileStreaming(
	file: Blob,
	chunkSize = HASH_SLICE_BYTES,
	onProgress?: (hashed: number, total: number) => void
): Promise<string> {
	if (file.size <= SUBTLE_DIGEST_MAX_BYTES) {
		onProgress?.(0, file.size);
		const hash = await sha256Blob(file);
		onProgress?.(file.size, file.size);
		return hash;
	}
	return sha256BlobStreaming(file, chunkSize, onProgress);
}

export async function sha256Uint8(data: Uint8Array): Promise<string> {
	return bytesToHex(await crypto.subtle.digest('SHA-256', asDigestSource(data)));
}
