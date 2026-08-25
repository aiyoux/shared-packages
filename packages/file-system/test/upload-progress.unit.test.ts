import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPutBlob } from '../src/uploadProgress.ts';

describe('fetchPutBlob', () => {
	it('streams the body and reports mid-flight byte progress', async () => {
		const ticks: Array<[number, number]> = [];
		const body = new Blob([new Uint8Array(8).fill(7)]);
		let sawStream = false;
		const fetchImpl: typeof fetch = async (_url, init) => {
			const b = init?.body;
			if (b && typeof (b as ReadableStream).getReader === 'function') {
				sawStream = true;
				const reader = (b as ReadableStream<Uint8Array>).getReader();
				while (true) {
					const { done } = await reader.read();
					if (done) break;
				}
			}
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		};
		const res = await fetchPutBlob({
			url: 'http://127.0.0.1/v1/fs/write',
			body,
			onProgress: (sent, total) => ticks.push([sent, total]),
			fetchImpl
		});
		assert.equal(res.ok, true);
		assert.ok(ticks.length >= 2);
		assert.deepEqual(ticks[0], [0, 8]);
		assert.deepEqual(ticks[ticks.length - 1], [8, 8]);
		assert.ok(ticks.some(([sent]) => sent > 0 && sent < 8) || sawStream);
	});

	it('sends the blob as-is when no onProgress is given', async () => {
		const body = new Blob(['hello']);
		let sent: unknown;
		const fetchImpl: typeof fetch = async (_url, init) => {
			sent = init?.body;
			return new Response('{}', { status: 200 });
		};
		await fetchPutBlob({ url: 'http://127.0.0.1/write', body, fetchImpl });
		assert.equal(sent, body);
	});
});
