/**
 * Content digest for large-file transfers.
 *
 * BLAKE3 (hash-wasm, ~9 kB gzipped) is the default: much faster than the JS
 * SHA-256 path on big files. SHA-256 remains available via SubtleCrypto.
 */
import { createBLAKE3 } from 'hash-wasm';
import {
	HASH_SLICE_BYTES,
	createSha256,
	sha256Chunks,
	sha256FileStreaming
} from './sha256.js';

export type FileDigestAlg = 'blake3' | 'sha256';

export const DEFAULT_FILE_DIGEST_ALG: FileDigestAlg = 'blake3';

export function isFileDigestAlg(value: unknown): value is FileDigestAlg {
	return value === 'blake3' || value === 'sha256';
}

export const FILE_DIGEST_LABEL: Record<FileDigestAlg, string> = {
	blake3: 'BLAKE3',
	sha256: 'SHA-256'
};

export type IncrementalDigest = {
	readonly alg: FileDigestAlg;
	update(data: Uint8Array): IncrementalDigest;
	digestHex(): string;
};

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

export async function createFileDigest(
	alg: FileDigestAlg = DEFAULT_FILE_DIGEST_ALG
): Promise<IncrementalDigest> {
	if (alg === 'sha256') {
		const hasher = createSha256();
		const wrap: IncrementalDigest = {
			alg,
			update(data) {
				hasher.update(data);
				return wrap;
			},
			digestHex() {
				return hasher.digestHex();
			}
		};
		return wrap;
	}

	const hasher = await createBLAKE3();
	hasher.init();
	const wrap: IncrementalDigest = {
		alg,
		update(data) {
			hasher.update(data);
			return wrap;
		},
		digestHex() {
			return hasher.digest('hex') as string;
		}
	};
	return wrap;
}

export async function digestChunks(
	chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
	alg: FileDigestAlg = DEFAULT_FILE_DIGEST_ALG,
	onProgress?: (hashed: number) => void
): Promise<string> {
	if (alg === 'sha256') return sha256Chunks(chunks, onProgress);
	const hasher = await createFileDigest('blake3');
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

export async function digestFileStreaming(
	file: Blob,
	alg: FileDigestAlg = DEFAULT_FILE_DIGEST_ALG,
	chunkSize = HASH_SLICE_BYTES,
	onProgress?: (hashed: number, total: number) => void
): Promise<string> {
	if (alg === 'sha256') return sha256FileStreaming(file, chunkSize, onProgress);
	const size = file.size;
	const step = Math.max(64 * 1024, chunkSize);
	const hasher = await createFileDigest('blake3');
	onProgress?.(0, size);
	for (let offset = 0; offset < size; offset += step) {
		const end = Math.min(offset + step, size);
		const slice = new Uint8Array(await file.slice(offset, end).arrayBuffer());
		hasher.update(slice);
		onProgress?.(end, size);
		if (end < size) await yieldToEventLoop();
	}
	return hasher.digestHex();
}
