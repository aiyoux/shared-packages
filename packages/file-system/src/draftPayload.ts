/**
 * Binary-safe encoding for `AppDraft.payload`.
 *
 * A draft is unsaved work, and for some apps unsaved work IS binary — the
 * voice recorder's crash draft is the audio you have not saved yet. The
 * payload column is JSON, and `JSON.stringify(blob)` is `{}`, so a Blob put
 * into a draft was silently replaced by an empty object. Nothing threw: the
 * write "succeeded", the read returned a payload whose `blob` was a bare
 * `{}`, and the app discarded it as corrupt. Crash drafts carrying audio
 * therefore never restored once drafts moved into the SQLite catalog.
 *
 * So binary is encoded explicitly on the way in and rebuilt on the way out.
 * Base64 costs a third more space than the bytes; a draft is a small, single,
 * short-lived row, and losing the user's unsaved recording costs more.
 *
 * Encoding is async because reading a Blob is. Decoding is sync so the row
 * decoder stays sync.
 */

const BLOB_TAG = '__vfsBlob';
const BYTES_TAG = '__vfsBytes';

type EncodedBlob = { [BLOB_TAG]: string; type: string };
type EncodedBytes = { [BYTES_TAG]: string };

/** Chunked so a large draft cannot blow the argument limit of `fromCharCode`. */
function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

function isEncodedBlob(v: unknown): v is EncodedBlob {
	return (
		!!v &&
		typeof v === 'object' &&
		typeof (v as Record<string, unknown>)[BLOB_TAG] === 'string'
	);
}

function isEncodedBytes(v: unknown): v is EncodedBytes {
	return (
		!!v &&
		typeof v === 'object' &&
		typeof (v as Record<string, unknown>)[BYTES_TAG] === 'string'
	);
}

/**
 * Replace every Blob and typed array in `payload` with a tagged, JSON-safe
 * stand-in. Everything else is passed through untouched.
 */
export async function encodeDraftPayload(payload: unknown): Promise<unknown> {
	if (payload === null || payload === undefined) return payload;

	if (typeof Blob !== 'undefined' && payload instanceof Blob) {
		const bytes = new Uint8Array(await payload.arrayBuffer());
		return { [BLOB_TAG]: bytesToBase64(bytes), type: payload.type } satisfies EncodedBlob;
	}
	if (payload instanceof Uint8Array) {
		return { [BYTES_TAG]: bytesToBase64(payload) } satisfies EncodedBytes;
	}
	if (payload instanceof ArrayBuffer) {
		return { [BYTES_TAG]: bytesToBase64(new Uint8Array(payload)) } satisfies EncodedBytes;
	}
	if (Array.isArray(payload)) {
		return Promise.all(payload.map((item) => encodeDraftPayload(item)));
	}
	// Plain objects only: a class instance would not survive JSON anyway, and
	// walking into one risks mangling something the app meant to keep.
	if (typeof payload === 'object' && isPlainObject(payload)) {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(payload)) {
			out[key] = await encodeDraftPayload(value);
		}
		return out;
	}
	return payload;
}

/** Rebuild what `encodeDraftPayload` replaced. Safe on payloads it never saw. */
export function decodeDraftPayload(payload: unknown): unknown {
	if (payload === null || payload === undefined) return payload;

	if (isEncodedBlob(payload)) {
		const bytes = base64ToBytes(payload[BLOB_TAG]);
		if (typeof Blob === 'undefined') return bytes;
		return new Blob([bytes as unknown as BlobPart], { type: payload.type || '' });
	}
	if (isEncodedBytes(payload)) return base64ToBytes(payload[BYTES_TAG]);
	if (Array.isArray(payload)) return payload.map(decodeDraftPayload);
	if (typeof payload === 'object' && isPlainObject(payload)) {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(payload)) out[key] = decodeDraftPayload(value);
		return out;
	}
	return payload;
}

function isPlainObject(v: object): v is Record<string, unknown> {
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
}
