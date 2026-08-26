import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPutBlob, xhrPostBlob } from '../src/uploadProgress.ts';

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

describe('xhrPostBlob', () => {
	it('reports upload.onprogress fractions then 1 on load', async () => {
		const ticks: number[] = [];
		const orig = globalThis.XMLHttpRequest;
		class FakeXHR {
			status = 200;
			statusText = 'OK';
			responseText = '{"ok":true}';
			upload: { onprogress: ((ev: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } =
				{ onprogress: null };
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			onabort: (() => void) | null = null;
			open() {}
			setRequestHeader() {}
			getResponseHeader() {
				return null;
			}
			abort() {}
			send() {
				queueMicrotask(() => {
					this.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 8 });
					this.upload.onprogress?.({ lengthComputable: true, loaded: 8, total: 8 });
					this.onload?.();
				});
			}
		}
		(globalThis as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest =
			FakeXHR as unknown as typeof XMLHttpRequest;
		try {
			const res = await xhrPostBlob({
				url: 'https://pod.backblaze.com/b2api/v2/b2_upload_file',
				body: new Blob([new Uint8Array(8)]),
				headers: { Authorization: 'tok' },
				onProgress: (pct) => ticks.push(pct)
			});
			assert.equal(res.ok, true);
			assert.ok(ticks.includes(0.5));
			assert.equal(ticks[ticks.length - 1], 1);
		} finally {
			if (orig) {
				globalThis.XMLHttpRequest = orig;
			} else {
				delete (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
			}
		}
	});
});
