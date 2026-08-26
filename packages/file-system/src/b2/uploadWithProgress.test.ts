import { describe, it, expect, afterEach } from 'vitest';
import {
	b2UploadHeaders,
	sha1HexOfBlob,
	uploadB2SmallFileWithProgress
} from './uploadWithProgress.js';
import { B2_DATA_PLANE_RELAY_PATH, B2_RELAY_METHOD_HEADER, B2_RELAY_URL_HEADER } from './dataPlaneRelay.js';

const UPLOAD_URL = 'https://pod-000-1000-00.backblaze.com/b2api/v2/b2_upload_file/x';

function installFakeXhr(opts: { fail?: boolean; progress?: boolean } = {}): void {
	class FakeXHR {
		status = 200;
		statusText = 'OK';
		responseText = JSON.stringify({
			fileId: 'fid',
			fileName: 'clip.bin',
			contentLength: 8,
			contentType: 'application/octet-stream',
			uploadTimestamp: 1
		});
		upload: {
			onprogress: ((ev: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
		} = { onprogress: null };
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
				if (opts.fail) {
					this.onerror?.();
					return;
				}
				if (opts.progress) {
					this.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 8 });
				}
				this.onload?.();
			});
		}
	}
	(globalThis as { XMLHttpRequest: typeof XMLHttpRequest }).XMLHttpRequest =
		FakeXHR as unknown as typeof XMLHttpRequest;
}

const origXhr = globalThis.XMLHttpRequest;

afterEach(() => {
	if (origXhr) {
		globalThis.XMLHttpRequest = origXhr;
	} else {
		delete (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
	}
});

describe('uploadB2SmallFileWithProgress', () => {
	it('percent-encodes spaces in X-Bz-File-Name', () => {
		const headers = b2UploadHeaders({
			authorization: 'tok',
			fileName: 'my clip.bin',
			contentType: 'b2/x-auto',
			contentSha1: 'abc'
		});
		expect(headers['X-Bz-File-Name']).toBe('my%20clip.bin');
	});

	it('ticks XHR upload progress', async () => {
		installFakeXhr({ progress: true });
		const ticks: number[] = [];
		const file = new Blob([new Uint8Array(8).fill(7)]);
		const sha1 = await sha1HexOfBlob(file);
		const info = await uploadB2SmallFileWithProgress({
			uploadUrl: UPLOAD_URL,
			authorizationToken: 'tok',
			fileName: 'clip.bin',
			file,
			contentSha1: sha1,
			onProgress: (pct) => ticks.push(pct)
		});
		expect(info.fileId).toBe('fid');
		expect(ticks[0]).toBe(0);
		expect(ticks).toContain(0.5);
		expect(ticks[ticks.length - 1]).toBe(1);
	});

	it('falls back to the data-plane relay when XHR CORS-fails', async () => {
		installFakeXhr({ fail: true });
		const ticks: number[] = [];
		const file = new Blob([new Uint8Array(8).fill(3)]);
		const sha1 = await sha1HexOfBlob(file);
		let relayUrl = '';
		let relayMethod = '';
		const fetchImpl: typeof fetch = async (url, init) => {
			const headers = new Headers(init?.headers);
			relayUrl = headers.get(B2_RELAY_URL_HEADER) ?? '';
			relayMethod = headers.get(B2_RELAY_METHOD_HEADER) ?? '';
			expect(String(url)).toContain(B2_DATA_PLANE_RELAY_PATH);
			expect(init?.method).toBe('POST');
			return new Response(
				JSON.stringify({
					fileId: 'relay-id',
					fileName: 'clip.bin',
					contentLength: 8,
					contentType: 'application/octet-stream',
					uploadTimestamp: 2
				}),
				{ status: 200 }
			);
		};
		const info = await uploadB2SmallFileWithProgress({
			uploadUrl: UPLOAD_URL,
			authorizationToken: 'tok',
			fileName: 'clip.bin',
			file,
			contentSha1: sha1,
			onProgress: (pct) => ticks.push(pct),
			fetchImpl
		});
		expect(info.fileId).toBe('relay-id');
		expect(relayUrl).toBe(UPLOAD_URL);
		expect(relayMethod).toBe('POST');
		expect(ticks[0]).toBe(0);
		expect(ticks[ticks.length - 1]).toBe(1);
	});
});
