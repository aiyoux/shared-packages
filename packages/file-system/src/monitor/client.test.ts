import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
	coerceGitSnapshot,
	createMonitorClient
} from './client.js';

const protocolDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'protocol');
const fixturesDir = path.join(protocolDir, 'fixtures');

function loadFixture(name: string): unknown {
	return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8'));
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

function ndjsonResponse(events: unknown[]): Response {
	const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
	return new Response(body, {
		status: 200,
		headers: { 'content-type': 'application/x-ndjson' }
	});
}

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

	it('hostSnapshot and gitSnapshot hit /v1/host and /v1/git', async () => {
		const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('/v1/host/snapshot')) {
				return new Response(
					JSON.stringify({
						cpu_pct: 12.5,
						mem_used: 100,
						mem_total: 400,
						disks: [{ name: '/', used: 10, total: 100 }]
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			}
			if (url.includes('/v1/git/snapshot')) {
				return new Response(
					JSON.stringify({
						branch: 'main',
						dirty: true,
						log: [{ sha: 'abc1234deadbeef', subject: 'init', author: 'A', committed_at: '2024-01-01' }]
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			}
			return new Response('Not found', { status: 404 });
		});
		const client = createMonitorClient({
			baseUrl: 'http://127.0.0.1:8300',
			fetchImpl: mockFetch as unknown as typeof fetch
		});
		const host = await client.hostSnapshot();
		expect(host.cpu_pct).toBe(12.5);
		expect(host.disks[0]?.name).toBe('/');
		expect(String(mockFetch.mock.calls[0]![0])).toBe('http://127.0.0.1:8300/v1/host/snapshot');

		const git = await client.gitSnapshot('/home/me/proj');
		expect(git.branch).toBe('main');
		expect(git.dirty).toBe(true);
		expect(git.log[0]?.subject).toBe('init');
		expect(String(mockFetch.mock.calls[1]![0])).toBe(
			'http://127.0.0.1:8300/v1/git/snapshot?path=%2Fhome%2Fme%2Fproj'
		);
	});

	it('openHostEvents and openGitEvents parse SSE snapshots', async () => {
		const encoder = new TextEncoder();
		const openSse = (event: string, payload: unknown) => {
			const stream = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
				}
			});
			return new Response(stream, {
				status: 200,
				headers: { 'content-type': 'text/event-stream' }
			});
		};
		const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith('/v1/host/events')) {
				return openSse('host.snapshot', { cpu_pct: 3, mem_used: 1, mem_total: 2, disks: [] });
			}
			if (url.includes('/v1/git/events')) {
				return openSse('git.snapshot', { branch: 'dev', dirty: false, log: [] });
			}
			return new Response('Not found', { status: 404 });
		});
		const client = createMonitorClient({
			baseUrl: 'http://127.0.0.1:8300',
			fetchImpl: mockFetch as unknown as typeof fetch
		});
		const hostSnaps: unknown[] = [];
		const host = await client.openHostEvents({ onSnapshot: (s) => hostSnaps.push(s) });
		await vi.waitFor(() => expect(hostSnaps).toHaveLength(1));
		expect(hostSnaps[0]).toEqual({ cpu_pct: 3, mem_used: 1, mem_total: 2, disks: [] });
		host.abort();

		const gitSnaps: unknown[] = [];
		const git = await client.openGitEvents('/tmp/repo', { onSnapshot: (s) => gitSnaps.push(s) });
		await vi.waitFor(() => expect(gitSnaps).toHaveLength(1));
		expect(gitSnaps[0]).toEqual({ branch: 'dev', dirty: false, log: [] });
		expect(String(mockFetch.mock.calls[1]![0])).toBe(
			'http://127.0.0.1:8300/v1/git/events?path=%2Ftmp%2Frepo'
		);
		git.abort();
	});

	it('pull / push / webrtc helpers hit the ferry contract', async () => {
		const calls: Array<{ url: string; method: string; headers: Headers; body?: unknown }> = [];
		const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? 'GET';
			const headers = new Headers(init?.headers);
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			calls.push({ url, method, headers, body });
			if (url.endsWith('/v1/fs/pull') || url.endsWith('/v1/fs/push')) {
				return ndjsonResponse([{ transferred: 2, size: 2, done: true }]);
			}
			if (url.endsWith('/v1/fs/webrtc/jobs') && method === 'POST') {
				return new Response(JSON.stringify({ jobId: 'job-1', token: 'tok-1' }), {
					status: 200,
					headers: { 'content-type': 'application/json', 'X-Fs-Job-Token': 'hdr-tok' }
				});
			}
			if (url.includes('/webrtc/jobs/') && url.endsWith('/offer') && method === 'GET') {
				return jsonResponse({ sdp: 'o' });
			}
			if (url.includes('/webrtc/jobs/') && url.endsWith('/offer') && method === 'POST') {
				return jsonResponse({ sdp: 'o' });
			}
			if (url.includes('/webrtc/jobs/') && url.endsWith('/answer') && method === 'POST') {
				return jsonResponse({ sdp: 'a' });
			}
			if (url.includes('/webrtc/jobs/') && url.endsWith('/answer')) {
				return jsonResponse({});
			}
			if (url.includes('/webrtc/jobs/') && url.endsWith('/progress')) {
				return ndjsonResponse([{ transferred: 1, size: 1, ice: 'connected', icePath: 'stun' }]);
			}
			if (url.includes('/webrtc/jobs/') && url.endsWith('/abort')) {
				return jsonResponse({ ok: true });
			}
			return new Response('Not found', { status: 404 });
		});
		const client = createMonitorClient({
			baseUrl: 'http://127.0.0.1:8300',
			fetchImpl: mockFetch as unknown as typeof fetch
		});

		const ticks: number[] = [];
		await client.pull('https://f000.example/file', '/tmp/out.bin', {
			jobToken: 'pull-tok',
			onProgress: (n) => ticks.push(n)
		});
		expect(calls[0]!.url).toBe('http://127.0.0.1:8300/v1/fs/pull');
		expect(calls[0]!.body).toEqual({ url: 'https://f000.example/file', to: '/tmp/out.bin' });
		expect(calls[0]!.headers.get('X-Fs-Job-Token')).toBe('pull-tok');
		expect(ticks).toContain(2);

		await client.push({
			from: '/tmp/in.bin',
			uploadUrl: 'https://pod.example/u',
			token: 'b2-up',
			fileName: 'in.bin',
			contentType: 'text/plain'
		});
		expect(calls[1]!.url).toBe('http://127.0.0.1:8300/v1/fs/push');
		expect(calls[1]!.body).toEqual({
			from: '/tmp/in.bin',
			uploadUrl: 'https://pod.example/u',
			token: 'b2-up',
			fileName: 'in.bin',
			contentType: 'text/plain'
		});

		const job = await client.webrtcCreateJob({ role: 'offerer', from: '/tmp/in.bin', size: 2 });
		expect(job).toEqual({ jobId: 'job-1', token: 'tok-1' });
		expect(calls[2]!.url).toBe('http://127.0.0.1:8300/v1/fs/webrtc/jobs');

		const offer = await client.webrtcGetOffer('job-1', 'tok-1');
		expect(offer.sdp).toBe('o');
		expect(calls[3]!.method).toBe('GET');
		expect(calls[3]!.url).toBe('http://127.0.0.1:8300/v1/fs/webrtc/jobs/job-1/offer');
		expect(calls[3]!.headers.get('Authorization')).toBe('Bearer tok-1');
		expect(calls[3]!.headers.get('X-Fs-Job-Token')).toBe('tok-1');
		expect(calls[3]!.body).toBeUndefined();

		const created = await client.webrtcCreateOffer('job-1', 'tok-1');
		expect(created.sdp).toBe('o');
		expect(calls[4]!.method).toBe('POST');
		expect(calls[4]!.url).toBe('http://127.0.0.1:8300/v1/fs/webrtc/jobs/job-1/offer');
		expect(calls[4]!.headers.get('Authorization')).toBe('Bearer tok-1');
		expect(calls[4]!.headers.get('X-Fs-Job-Token')).toBe('tok-1');

		const answer = await client.webrtcPostAnswer('job-1', 'tok-1', 'o');
		expect(answer.sdp).toBe('a');
		await client.webrtcPostAnswer('job-1', 'tok-1', 'a');

		const ice: string[] = [];
		await client.webrtcProgress('job-1', 'tok-1', {
			onEvent: (ev) => {
				if (ev.icePath) ice.push(ev.icePath);
			}
		});
		expect(ice).toEqual(['stun']);
		await client.webrtcAbort('job-1', 'tok-1');
		expect(calls.some((c) => c.url.endsWith('/abort'))).toBe(true);
	});
});

describe('monitor protocol fixtures', () => {
	it('sha256 of each fixture matches fixtures.sha256 (bytes must not drift)', () => {
		const listed = new Set(readdirSync(fixturesDir).filter((n) => n.endsWith('.json')));
		const lines = readFileSync(path.join(protocolDir, 'fixtures.sha256'), 'utf8')
			.trim()
			.split('\n')
			.filter(Boolean);
		expect(lines.length).toBeGreaterThan(0);
		const hashed = new Set<string>();
		for (const line of lines) {
			const m = line.match(/^([0-9a-f]{64})  (.+)$/);
			expect(m, `sha256sum line: ${line}`).toBeTruthy();
			const [, hash, filename] = m!;
			hashed.add(filename);
			const bytes = readFileSync(path.join(fixturesDir, filename));
			const actual = createHash('sha256').update(bytes).digest('hex');
			expect(actual, filename).toBe(hash);
		}
		expect(hashed).toEqual(listed);
	});
});

describe('monitor client tolerant parse', () => {
	it('parses old meta with missing capabilities as all-false', async () => {
		const mockFetch = vi.fn(async (_input: RequestInfo | URL) => jsonResponse(loadFixture('meta.old.json')));
		const client = createMonitorClient({
			baseUrl: 'http://127.0.0.1:8300',
			fetchImpl: mockFetch as unknown as typeof fetch
		});
		const meta = await client.meta();
		expect(meta.name).toBe('monitor');
		expect(meta.features).toEqual(['watch', 'fs', 'host', 'git']);
		expect(meta.capabilities?.fs?.ino).toBe(false);
		expect(meta.capabilities?.fs?.rename).toBe(false);
		expect(meta.capabilities?.fs?.archive).toBe(false);
		expect(meta.capabilities?.fs?.mkdir).toBe(false);
		expect(meta.capabilities?.git?.blob).toBe(false);
		expect(String(mockFetch.mock.calls[0]![0])).toBe('http://127.0.0.1:8300/v1/meta');
	});

	it('parses new meta capabilities', async () => {
		const mockFetch = vi.fn(async (_input: RequestInfo | URL) => jsonResponse(loadFixture('meta.new.json')));
		const client = createMonitorClient({
			baseUrl: 'http://127.0.0.1:8300',
			fetchImpl: mockFetch as unknown as typeof fetch
		});
		const meta = await client.meta();
		expect(meta.capabilities?.fs?.ino).toBe(true);
		expect(meta.capabilities?.fs?.rename).toBe(true);
		expect(meta.capabilities?.fs?.archive).toBe(true);
		expect(meta.capabilities?.fs?.mkdir).toBe(true);
		expect(meta.capabilities?.git?.blob).toBe(true);
	});

	it('ignores extra JSON fields on meta', async () => {
		const mockFetch = vi.fn(async (_input: RequestInfo | URL) =>
			jsonResponse({
				name: 'monitor',
				version: '0.1.0',
				features: ['fs'],
				extra: 'ignored',
				capabilities: { fs: { ino: true, rename: false, extra: 1 }, git: { blob: false }, other: true }
			})
		);
		const client = createMonitorClient({
			baseUrl: 'http://127.0.0.1:8300',
			fetchImpl: mockFetch as unknown as typeof fetch
		});
		const meta = await client.meta();
		expect(meta.capabilities).toEqual({
			fs: { ino: true, rename: false, archive: false, mkdir: false },
			git: { blob: false }
		});
		expect(meta).not.toHaveProperty('extra');
	});

	it('parses old list without ino and new list/stat with string ino/dev', async () => {
		const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('/v1/fs/list') && url.includes('old')) {
				return jsonResponse(loadFixture('list.old.json'));
			}
			if (url.includes('/v1/fs/list')) return jsonResponse(loadFixture('list.new.json'));
			if (url.includes('/v1/fs/stat')) return jsonResponse(loadFixture('stat.new.json'));
			return new Response('Not found', { status: 404 });
		});
		const client = createMonitorClient({
			baseUrl: 'http://127.0.0.1:8300',
			fetchImpl: mockFetch as unknown as typeof fetch
		});
		const oldList = await client.list('/old');
		expect(oldList.entries[0]?.ino).toBeUndefined();
		expect(oldList.entries[0]?.dev).toBeUndefined();
		expect(oldList.entries[0]?.name).toBe('a.png');

		const list = await client.list('/tmp');
		expect(list.entries[0]?.ino).toBe('12345');
		expect(list.entries[0]?.dev).toBe('1');
		expect(typeof list.entries[0]?.ino).toBe('string');
		expect(typeof list.entries[0]?.dev).toBe('string');

		const st = await client.stat('/tmp/a.png');
		expect(st.ino).toBe('12345');
		expect(st.dev).toBe('1');
		expect(typeof st.ino).toBe('string');
	});

	it('coerces numeric ino/dev to decimal strings and ignores extra list fields', async () => {
		const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('/v1/fs/list')) {
				return jsonResponse({
					path: '/tmp',
					truncated: false,
					extra: true,
					entries: [
						{
							name: 'a.png',
							path: '/tmp/a.png',
							kind: 'file',
							size: 12,
							mtime_ms: 1700000000000,
							ino: 12345,
							dev: 1,
							mode: 0o644
						}
					]
				});
			}
			if (url.includes('/v1/fs/stat')) {
				return jsonResponse({
					name: 'a.png',
					path: '/tmp/a.png',
					kind: 'file',
					size: 12,
					mtime_ms: 1700000000000,
					ino: 99,
					dev: 2,
					uid: 1000
				});
			}
			return new Response('Not found', { status: 404 });
		});
		const client = createMonitorClient({
			baseUrl: 'http://127.0.0.1:8300',
			fetchImpl: mockFetch as unknown as typeof fetch
		});
		const list = await client.list('/tmp');
		expect(list.entries[0]?.ino).toBe('12345');
		expect(list.entries[0]?.dev).toBe('1');
		expect(list.entries[0]).not.toHaveProperty('mode');
		expect(list).not.toHaveProperty('extra');
		const st = await client.stat('/tmp/a.png');
		expect(st.ino).toBe('99');
		expect(st.dev).toBe('2');
		expect(st).not.toHaveProperty('uid');
	});

	it('rename POSTs /v1/fs/rename {from,to} and gitBlob GETs /v1/git/blob', async () => {
		const calls: { url: string; method?: string; body?: unknown }[] = [];
		const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? 'GET';
			const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
			calls.push({ url, method, body });
			if (url.includes('/v1/fs/rename')) return jsonResponse({ ok: true });
			if (url.includes('/v1/git/blob')) {
				return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
			}
			return new Response('Not found', { status: 404 });
		});
		const client = createMonitorClient({
			baseUrl: 'http://127.0.0.1:8300',
			fetchImpl: mockFetch as unknown as typeof fetch
		});
		await client.rename!('/tmp/a.png', '/tmp/b.png');
		expect(calls[0]).toEqual({
			url: 'http://127.0.0.1:8300/v1/fs/rename',
			method: 'POST',
			body: { from: '/tmp/a.png', to: '/tmp/b.png' }
		});
		const blob = await client.gitBlob!('/tmp/repo', 'HEAD', 'a.png');
		expect(Array.from(blob)).toEqual([1, 2, 3]);
		expect(calls[1]!.url).toBe(
			'http://127.0.0.1:8300/v1/git/blob?path=%2Ftmp%2Frepo&rev=HEAD&file=a.png'
		);
		expect(calls[1]!.method).toBe('GET');
	});

	it('git-snapshot fixture extra fields are ignored', () => {
		const snap = coerceGitSnapshot(loadFixture('git-snapshot.json'));
		expect(snap).toEqual({
			branch: 'main',
			dirty: false,
			log: [
				{
					sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
					subject: 'init',
					author: 'e2e',
					committed_at: '2024-01-01T00:00:00Z'
				}
			]
		});
	});
});
