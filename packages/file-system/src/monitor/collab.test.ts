import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
	CollabConflictError,
	getSnapshot,
	postOps,
	postPresence,
	postSubs,
	submitPage,
	subscribe
} from './collab.js';

const src = readFileSync(fileURLToPath(new URL('./collab.ts', import.meta.url)), 'utf8');

const encoder = new TextEncoder();

function sseResponse(frames: string[]): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			for (const f of frames) c.enqueue(encoder.encode(f));
		}
	});
	return new Response(stream, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' }
	});
}

describe('monitor collab client', () => {
	it('does not construct WebSocket or EventSource', () => {
		expect(src).not.toMatch(/new\s+WebSocket\b/);
		expect(src).not.toMatch(/new\s+EventSource\b/);
		expect(src).toMatch(/openJsonSse/);
		expect(src).toMatch(/withLocalAddressSpace/);
		expect(src).toMatch(/\/v1\/collab\/events/);
		expect(src).not.toMatch(/\/v1\/collab\/stream/);
	});

	it('subscribe annotates LAN URLs with local, not loopback', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			expect(url).toBe('http://192.168.1.10:8300/v1/collab/events');
			expect((init as { targetAddressSpace?: string }).targetAddressSpace).toBe('local');
			expect((init as { targetAddressSpace?: string }).targetAddressSpace).not.toBe(
				'loopback'
			);
			return sseResponse([
				`event: collab.hello\ndata: ${JSON.stringify({ type: 'collab.hello', client_id: 'c1' })}\n\n`
			]);
		});
		const { abort } = await subscribe({
			baseUrl: 'http://192.168.1.10:8300',
			fetchImpl: fetchMock as unknown as typeof fetch,
			onEvent: () => {}
		});
		expect(fetchMock).toHaveBeenCalled();
		abort();
	});

	it('subscribe opens SSE with withLocalAddressSpace (loopback)', async () => {
		const events: Array<{ event: string; data: unknown }> = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			expect(url).toBe('http://127.0.0.1:9847/v1/collab/events');
			expect(init?.method).toBe('GET');
			expect((init as { targetAddressSpace?: string }).targetAddressSpace).toBe('loopback');
			expect(init?.headers).toEqual({ accept: 'text/event-stream' });
			return sseResponse([
				`event: collab.hello\ndata: ${JSON.stringify({ type: 'collab.hello', client_id: 'c1' })}\n\n`
			]);
		});
		const { abort } = await subscribe({
			baseUrl: 'http://127.0.0.1:9847',
			fetchImpl: fetchMock as unknown as typeof fetch,
			onEvent: (event, data) => events.push({ event, data })
		});
		await vi.waitFor(() => expect(events.some((e) => e.event === 'collab.hello')).toBe(true));
		expect(events[0]?.data).toMatchObject({ client_id: 'c1' });
		abort();
	});

	it('POST helpers annotate loopback and JSON bodies', async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, init: init ?? {} });
			if (url.includes('/ops')) {
				return new Response(JSON.stringify({ seq: 6 }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
			if (url.includes('/snapshot') && (init?.method ?? 'GET') === 'POST') {
				return new Response(JSON.stringify({ seq: 6 }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
			if (url.includes('/snapshot')) {
				return new Response(JSON.stringify({ seq: 5, page: { id: 'p' } }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
			if (url.includes('/presence')) {
				return new Response(null, { status: 204 });
			}
			if (url.includes('/subs')) {
				return new Response(
					JSON.stringify({
						subscribed: [{ sub_id: 's1', path: '/tmp/index.kb' }],
						unsubscribed: []
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			}
			return new Response('no', { status: 404 });
		});
		const opts = {
			baseUrl: 'http://127.0.0.1:8300',
			fetchImpl: fetchMock as unknown as typeof fetch
		};
		const page = { id: 'p', blocks: [] };
		await expect(
			postOps(opts, {
				clientId: '11111111-1111-1111-1111-111111111111',
				path: '/tmp/index.kb',
				baseSeq: 5,
				ops: [{ kind: 'insert-text' }]
			})
		).resolves.toEqual({ seq: 6 });
		await expect(
			submitPage({ ...opts, path: '/tmp/index.kb', clientId: 'c1' }, 6, page)
		).resolves.toEqual({ seq: 6 });
		await expect(getSnapshot(opts, '/tmp/index.kb')).resolves.toEqual({
			seq: 5,
			page: { id: 'p' }
		});
		await postPresence(opts, {
			clientId: 'c1',
			path: '/tmp/index.kb',
			state: { user: { name: 'a' } }
		});
		await postSubs(opts, {
			clientId: 'c1',
			subscribe: [{ path: '/tmp/index.kb' }]
		});

		for (const c of calls) {
			expect((c.init as { targetAddressSpace?: string }).targetAddressSpace).toBe('loopback');
			expect(c.url).not.toMatch(/websocket|ws:/i);
		}
		expect(calls.map((c) => c.init.method)).toEqual(['POST', 'POST', 'GET', 'POST', 'POST']);
		expect(JSON.parse(String(calls[0].init.body))).toEqual({
			client_id: '11111111-1111-1111-1111-111111111111',
			path: '/tmp/index.kb',
			base_seq: 5,
			ops: [{ kind: 'insert-text' }]
		});
		expect(JSON.parse(String(calls[1].init.body))).toEqual({
			client_id: 'c1',
			path: '/tmp/index.kb',
			seq: 6,
			page
		});
		expect(calls[2].url).toContain('/v1/collab/snapshot?path=');
	});

	it('turns 409 { head_seq } into CollabConflictError for ops and submitPage', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('/ops') || url.includes('/snapshot')) {
				return new Response(JSON.stringify({ head_seq: 6 }), {
					status: 409,
					headers: { 'content-type': 'application/json' }
				});
			}
			return new Response('no', { status: 404 });
		});
		const opts = {
			baseUrl: 'http://127.0.0.1:8300',
			fetchImpl: fetchMock as unknown as typeof fetch
		};
		await expect(
			postOps(opts, { clientId: 'c', path: '/tmp/a.kb', baseSeq: 5, ops: [{}] })
		).rejects.toMatchObject({ name: 'CollabConflictError', headSeq: 6, status: 409 });
		await expect(submitPage({ ...opts, path: '/tmp/a.kb' }, 5, { id: 'x' })).rejects.toBeInstanceOf(
			CollabConflictError
		);
		try {
			await submitPage({ ...opts, path: '/tmp/a.kb' }, 5, { id: 'x' });
			throw new Error('expected conflict');
		} catch (e) {
			expect(e).toBeInstanceOf(CollabConflictError);
			expect((e as CollabConflictError).headSeq).toBe(6);
		}
	});

	it('submitPage matching bytes is a no-op 200; differing bytes 409', async () => {
		let stored: string | null = null;
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			expect((init as { targetAddressSpace?: string }).targetAddressSpace).toBe('loopback');
			const body = JSON.parse(String(init?.body ?? '{}')) as { seq?: number; page?: unknown };
			const bytes = JSON.stringify(body.page);
			if (stored === null || stored === bytes) {
				stored = bytes;
				return new Response(JSON.stringify({ seq: body.seq ?? 1 }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
			return new Response(JSON.stringify({ head_seq: 1 }), {
				status: 409,
				headers: { 'content-type': 'application/json' }
			});
		});
		const opts = {
			baseUrl: 'http://127.0.0.1:8300',
			path: '/tmp/index.kb',
			fetchImpl: fetchMock as unknown as typeof fetch
		};
		const page = { id: 'p', blocks: [] };
		await expect(submitPage(opts, 1, page)).resolves.toEqual({ seq: 1 });
		await expect(submitPage(opts, 1, page)).resolves.toEqual({ seq: 1 });
		await expect(submitPage(opts, 1, { id: 'other', blocks: [] })).rejects.toMatchObject({
			name: 'CollabConflictError',
			headSeq: 1,
			status: 409
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('getSnapshot seq is the CAS seq, not inferred from a 409 head', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			expect((init as { targetAddressSpace?: string }).targetAddressSpace).toBe('loopback');
			return new Response(JSON.stringify({ seq: 5, page: { id: 'behind' } }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		});
		const snap = await getSnapshot(
			{ baseUrl: 'http://127.0.0.1:8300', fetchImpl: fetchMock as unknown as typeof fetch },
			'/tmp/index.kb'
		);
		expect(snap.seq).toBe(5);
		expect(snap.seq).not.toBe(6);
		expect(snap.page).toEqual({ id: 'behind' });
	});
});

describe('collab.ts source location', () => {
	it('lives next to the other monitor clients', () => {
		expect(path.basename(fileURLToPath(new URL('./collab.ts', import.meta.url)))).toBe('collab.ts');
	});
});
