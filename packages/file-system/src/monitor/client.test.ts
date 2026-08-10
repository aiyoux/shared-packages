import { describe, it, expect, vi } from 'vitest';
import { createMonitorClient } from './client.js';

describe('monitor client (direct transport)', () => {
	it('makes direct HTTP requests to base URL without routing through worker proxy', async () => {
		const calls: { url: string; method?: string; body?: unknown }[] = [];
		const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? 'GET';
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			calls.push({ url, method, body });

			if (url.includes('/v1/fs/list')) {
				return new Response(JSON.stringify({ path: '/tmp', entries: [], truncated: false }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
			if (url.includes('/v1/fs/stat')) {
				return new Response(JSON.stringify({ name: 'tmp', path: '/tmp', kind: 'folder' }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
			if (url.includes('/v1/health')) {
				return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
			}
			if (url.includes('/v1/watch/roots') && method === 'POST') {
				return new Response(JSON.stringify({ root_id: 'r1', path: '/tmp' }), { status: 200 });
			}
			if (url.includes('/v1/watch/roots') && method === 'GET') {
				return new Response(JSON.stringify({ roots: [] }), { status: 200 });
			}
			if (url.includes('/v1/fs/read')) {
				return new Response(new Blob(['hello']), { status: 200 });
			}
			return new Response('Not found', { status: 404 });
		});

		const baseUrl = 'http://192.168.1.50:8300';
		const client = createMonitorClient({ baseUrl, fetchImpl: mockFetch as unknown as typeof fetch });

		// 1. List
		const listRes = await client.list('/tmp');
		expect(listRes.path).toBe('/tmp');
		expect(calls[0].url).toBe('http://192.168.1.50:8300/v1/fs/list?path=%2Ftmp');
		expect(calls[0].url).not.toContain('/api/monitor');

		// 2. Stat
		await client.stat('/tmp');
		expect(calls[1].url).toBe('http://192.168.1.50:8300/v1/fs/stat?path=%2Ftmp');
		expect(calls[1].url).not.toContain('/api/monitor');

		// 3. Health
		await client.health();
		expect(calls[2].url).toBe('http://192.168.1.50:8300/v1/health');
		expect(calls[2].url).not.toContain('/api/monitor');

		// 4. Watch add root
		await client.watchAddRoot('/tmp', true);
		expect(calls[3].url).toBe('http://192.168.1.50:8300/v1/watch/roots');
		expect(calls[3].method).toBe('POST');
		expect(calls[3].body).toEqual({ path: '/tmp', recursive: true });

		// 5. Watch list roots
		await client.watchListRoots();
		expect(calls[4].url).toBe('http://192.168.1.50:8300/v1/watch/roots');
		expect(calls[4].method).toBe('GET');

		// 6. Download
		const blob = await client.download('/tmp/file.txt');
		expect(await blob.text()).toBe('hello');
		expect(calls[5].url).toBe('http://192.168.1.50:8300/v1/fs/read?path=%2Ftmp%2Ffile.txt');
		expect(calls[5].url).not.toContain('/api/monitor');
	});
});
