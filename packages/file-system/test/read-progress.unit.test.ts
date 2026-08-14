import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blobFromResponse } from '../src/readProgress.ts';

describe('blobFromResponse', () => {
	it('streams chunks and reports growing transferred', async () => {
		const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
		let i = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(ctrl) {
				if (i < chunks.length) ctrl.enqueue(chunks[i++]!);
				else ctrl.close();
			}
		});
		const res = new Response(stream, {
			headers: { 'content-type': 'application/octet-stream', 'content-length': '5' }
		});
		const seen: number[] = [];
		const blob = await blobFromResponse(res, {
			onProgress: (n) => {
				seen.push(n);
			}
		});
		assert.equal(blob.size, 5);
		assert.ok(seen.includes(5));
		assert.ok(seen[0]! <= seen[seen.length - 1]!);
	});

	it('rejects when maxBytes is exceeded', async () => {
		const res = new Response(new Uint8Array([1, 2, 3, 4]));
		await assert.rejects(
			() => blobFromResponse(res, { maxBytes: 2 }),
			/EXPLORER_TOO_LARGE/
		);
	});
});
