import { describe, expect, it, vi, afterEach } from 'vitest';
import {
	DEFAULT_BRIDGE_BASE_URL,
	bridgeFetchUrl,
	fetchModelFileViaBridge
} from './bridgeFetch.js';
import { WHISPER_TINY } from './models.js';
import { SpeechEngineError } from './types.js';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('bridgeFetchUrl', () => {
	it('points at the fetch proxy with the HF resolve URL encoded', () => {
		const url = bridgeFetchUrl(DEFAULT_BRIDGE_BASE_URL, WHISPER_TINY, 'config.json');
		expect(url).toBe(
			'http://127.0.0.1:9847/v1/tools/fetch?url=' +
				encodeURIComponent(
					'https://huggingface.co/onnx-community/whisper-tiny/resolve/main/config.json'
				)
		);
	});

	it('trims trailing slashes from the base URL', () => {
		expect(bridgeFetchUrl('http://127.0.0.1:9847///', WHISPER_TINY, 'config.json')).toBe(
			bridgeFetchUrl(DEFAULT_BRIDGE_BASE_URL, WHISPER_TINY, 'config.json')
		);
	});
});

describe('fetchModelFileViaBridge', () => {
	it('rejects unreachable bridges with DOWNLOAD_FAILED', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('refused')));
		const err = await fetchModelFileViaBridge(
			DEFAULT_BRIDGE_BASE_URL,
			WHISPER_TINY,
			'config.json'
		).catch((e) => e);
		expect(err).toBeInstanceOf(SpeechEngineError);
		expect((err as SpeechEngineError).code).toBe('DOWNLOAD_FAILED');
	});

	it('rejects upstream HTTP errors with the status', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response('nope', { status: 502 }))
		);
		await expect(
			fetchModelFileViaBridge(DEFAULT_BRIDGE_BASE_URL, WHISPER_TINY, 'config.json')
		).rejects.toThrow('HTTP 502');
	});

	it('returns the live response when the bridge answers', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])))
		);
		const res = await fetchModelFileViaBridge(
			DEFAULT_BRIDGE_BASE_URL,
			WHISPER_TINY,
			'config.json'
		);
		expect(res.ok).toBe(true);
	});
});
