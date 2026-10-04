/**
 * Read part of a remote file through a URL that honours `Range: bytes=`.
 *
 * Preview reads only what it shows (the start of a text file, the parts of a
 * PDF that draw one page) instead of the whole file. A server that ignores the
 * header answers 200 with the whole body; the reader then stops as soon as it
 * has the bytes it asked for and cancels the rest.
 */
import { withLocalAddressSpace } from '../monitor/localNetwork.js';
import { recordLinkTransfer } from '../linkSpeed.js';
import type { ExplorerDriver, ExplorerEntryId } from './explorerDriver.js';

export type ByteRangeResult = {
	bytes: Uint8Array<ArrayBuffer>;
	/** Whole file length, from `Content-Range` (or `Content-Length` on a 200). */
	total?: number;
};

/** Bytes `start..=end` of `url`. `end` past the file is clamped by the server. */
export async function fetchByteRange(
	url: string,
	start: number,
	end: number,
	opts?: { signal?: AbortSignal; fetchImpl?: typeof fetch }
): Promise<ByteRangeResult> {
	const fetchFn = opts?.fetchImpl ?? fetch;
	const started = performance.now();
	const res = await fetchFn(
		url,
		withLocalAddressSpace(url, {
			method: 'GET',
			headers: { range: `bytes=${start}-${end}` },
			signal: opts?.signal
		})
	);
	if (res.status === 416) {
		await res.body?.cancel().catch(() => {});
		const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1]);
		return { bytes: new Uint8Array(0), total: Number.isFinite(total) ? total : undefined };
	}
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(text || `Read failed (${res.status})`);
	}
	const want = end - start + 1;
	const ranged = res.status === 206;
	const totalHeader = ranged
		? Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1])
		: Number(res.headers.get('content-length') || '');
	const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : undefined;
	// A 200 is the whole file from byte 0: skip to `start`, stop after `end`.
	const skip = ranged ? 0 : start;
	const limit = ranged ? want : start + want;
	const pieces: Uint8Array[] = [];
	let seen = 0;
	let length = 0;
	const reader = res.body?.getReader();
	if (reader) {
		try {
			while (seen < limit) {
				const { done, value } = await reader.read();
				if (done || !value) break;
				const from = Math.max(0, skip - seen);
				const to = Math.min(value.byteLength, limit - seen);
				if (to > from) {
					pieces.push(value.subarray(from, to));
					length += to - from;
				}
				seen += value.byteLength;
			}
		} finally {
			void reader.cancel().catch(() => {});
		}
	}
	const bytes = new Uint8Array(length);
	let at = 0;
	for (const piece of pieces) {
		bytes.set(piece, at);
		at += piece.byteLength;
	}
	recordLinkTransfer(url, length, performance.now() - started);
	return { bytes, total };
}

/** Bytes `start..=end` of an explorer entry, when its driver can read a range. */
export async function readExplorerRange(
	driver: Pick<ExplorerDriver, 'rangeUrl'>,
	id: ExplorerEntryId,
	start: number,
	end: number,
	opts?: { signal?: AbortSignal }
): Promise<ByteRangeResult | null> {
	const loc = await driver.rangeUrl?.(id);
	if (!loc?.url) return null;
	return fetchByteRange(loc.url, start, end, opts);
}
