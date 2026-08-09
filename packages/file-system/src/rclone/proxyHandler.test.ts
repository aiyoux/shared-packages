import { describe, it, expect, vi } from 'vitest';
import {
	handleRcloneRcProxy,
	handleRcloneUploadProxy,
	handleRcloneDownloadProxy
} from './proxyHandler.js';

describe('proxyHandler', () => {
	it('rejects non-loopback target (SSRF)', async () => {
		const r = await handleRcloneRcProxy({
			body: { target: 'http://evil.com:7750', method: 'operations/list', params: {} },
			fetchImpl: vi.fn()
		});
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.code).toBe('RCLONE_SSRF');
			expect(r.status).toBe(400);
		}
	});

	it('rejects denied methods', async () => {
		const r = await handleRcloneRcProxy({
			body: { target: 'http://127.0.0.1:7750', method: 'core/command', params: {} },
			fetchImpl: vi.fn()
		});
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.code).toBe('RCLONE_METHOD_DENIED');
			expect(r.status).toBe(403);
		}
	});

	it('relays allowed method with Basic auth', async () => {
		const fetchImpl = vi.fn(async () => {
			return new Response(JSON.stringify({ list: [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		});
		const r = await handleRcloneRcProxy({
			body: {
				target: 'http://127.0.0.1:7750',
				method: 'operations/list',
				params: { fs: 'home:', remote: '' }
			},
			authorization: 'Basic dGVzdA==',
			fetchImpl: fetchImpl as unknown as typeof fetch
		});
		expect(r.ok).toBe(true);
		expect(fetchImpl).toHaveBeenCalled();
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(String(url)).toContain('127.0.0.1:7750');
		expect(String(url)).toContain('operations/list');
		expect((init as RequestInit).headers).toMatchObject({
			Authorization: 'Basic dGVzdA=='
		});
	});

	it('strips underscore params', async () => {
		const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? '{}'));
			expect(body._config).toBeUndefined();
			expect(body.fs).toBe('home:');
			return new Response('{}', { status: 200 });
		});
		const r = await handleRcloneRcProxy({
			body: {
				target: 'http://127.0.0.1:7750',
				method: 'operations/about',
				params: { fs: 'home:', _config: { evil: true } }
			},
			fetchImpl: fetchImpl as unknown as typeof fetch
		});
		expect(r.ok).toBe(true);
	});

	it('upload rejects SSRF', async () => {
		const r = await handleRcloneUploadProxy({
			target: 'http://8.8.8.8:7750',
			fs: 'x:',
			remote: 'a',
			file: new Blob([new Uint8Array([1])]),
			fetchImpl: vi.fn()
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe('RCLONE_SSRF');
	});

	it('download rejects SSRF', async () => {
		const r = await handleRcloneDownloadProxy({
			target: 'http://metadata:7750',
			fs: 'x:',
			remote: 'a',
			fetchImpl: vi.fn()
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe('RCLONE_SSRF');
	});
});
