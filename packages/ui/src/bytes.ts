/**
 * Byte helpers for the DOM boundary.
 *
 * TypeScript 5.7 made `Uint8Array` generic over its backing buffer, so an
 * unannotated `Uint8Array` is `Uint8Array<ArrayBufferLike>` — which includes
 * `SharedArrayBuffer`. `BlobPart` and `BufferSource` accept only
 * `ArrayBufferView<ArrayBuffer>`, so `new Blob([bytes])` stopped type-checking
 * across the repo even though nothing here ever produces shared memory.
 *
 * `toBlobPart` states that intent in one place instead of scattering casts.
 */

/**
 * Narrow a byte view for `Blob`/`BufferSource` use.
 *
 * Copies only when the view is genuinely backed by a `SharedArrayBuffer`,
 * which the structured-clone and Blob APIs reject at runtime. The common case
 * is an ordinary `ArrayBuffer` and returns the same view untouched.
 */
export function toBlobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const buf = bytes.buffer;
	if (typeof SharedArrayBuffer !== 'undefined' && buf instanceof SharedArrayBuffer) {
		return new Uint8Array(bytes);
	}
	return bytes as Uint8Array<ArrayBuffer>;
}

/**
 * Copy a byte view's exact range into a standalone `ArrayBuffer`.
 *
 * `bytes.buffer` is `ArrayBufferLike`, so slicing it yields
 * `ArrayBuffer | SharedArrayBuffer` and will not pass where a plain
 * `ArrayBuffer` is required — even though the copy is always unshared.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const out = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(out).set(bytes);
	return out;
}
