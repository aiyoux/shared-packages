import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	KB_SCHEMA_VERSION,
	REPLICA_SEND_SNAPSHOT_ERROR,
	createEmptyPage,
	type CollabFrame,
	type KbPage,
	type Op
} from '@shared-packages/kb-model';
import {
	clearMonitorCollabMuxForTests,
	createMonitorCollabSession,
	maySubmitMonitorPage,
	seedMonitorSessionPage,
	stripInFlightPage
} from './collabSession.js';

const src = readFileSync(fileURLToPath(new URL('./collabSession.ts', import.meta.url)), 'utf8');

const encoder = new TextEncoder();
const HELLO_ID = '11111111-1111-1111-1111-111111111111';

function paraPage(text: string, id = 'page-1'): KbPage {
	const page = createEmptyPage({ id, title: 'T' });
	const block = page.blocks[0];
	if (block && block.type === 'paragraph') {
		block.id = 'b1';
		block.content = [{ type: 'text', text, marks: [] }];
	}
	return page;
}

function insertOp(text: string): Op {
	return { kind: 'insert-text', at: { blockId: 'b1', offset: 0 }, text };
}

function sseFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createHarness() {
	const encoderLocal = encoder;
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let streamsOpened = 0;
	const posts: Array<{ url: string; body: unknown }> = [];
	let snapshotMem: { seq: number; page: unknown } = { seq: 0, page: paraPage('') };
	let opsHandler: ((body: Record<string, unknown>) => Response | Promise<Response>) | null = null;

	const emit = (event: string, data: unknown) => {
		controller?.enqueue(encoderLocal.encode(sseFrame(event, data)));
	};

	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = (init?.method ?? 'GET').toUpperCase();
		expect((init as { targetAddressSpace?: string }).targetAddressSpace).toBe('loopback');
		if (url.includes('/v1/collab/events')) {
			streamsOpened += 1;
			const stream = new ReadableStream<Uint8Array>({
				start(c) {
					controller = c;
					queueMicrotask(() =>
						emit('collab.hello', { type: 'collab.hello', client_id: HELLO_ID })
					);
				},
				cancel() {
					controller = null;
				}
			});
			init?.signal?.addEventListener('abort', () => {
				try {
					controller?.error(new DOMException('aborted', 'AbortError'));
				} catch {
					/* closed */
				}
				controller = null;
			});
			return new Response(stream, {
				status: 200,
				headers: { 'content-type': 'text/event-stream' }
			});
		}
		if (url.includes('/v1/collab/subs') && method === 'POST') {
			const body = JSON.parse(String(init?.body ?? '{}')) as {
				subscribe?: Array<{ path: string }>;
				unsubscribe?: string[];
			};
			posts.push({ url, body });
			const subscribed = (body.subscribe ?? []).map((s, i) => ({
				sub_id: `sub-${s.path}-${i}`,
				path: s.path
			}));
			for (const row of subscribed) {
				queueMicrotask(() =>
					emit('collab.subscribed', {
						type: 'collab.subscribed',
						sub_id: row.sub_id,
						path: row.path
					})
				);
			}
			return new Response(JSON.stringify({ subscribed, unsubscribed: [] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}
		if (url.includes('/v1/collab/ops') && method === 'POST') {
			const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
			posts.push({ url, body });
			if (opsHandler) return opsHandler(body);
			const seq = Number(body.base_seq) + 1;
			queueMicrotask(() =>
				emit('collab.op_batch', {
					type: 'collab.op_batch',
					sub_id: `sub-${body.path}-0`,
					seq,
					client_id: body.client_id,
					ops: body.ops
				})
			);
			return new Response(JSON.stringify({ seq }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}
		if (url.includes('/v1/collab/snapshot') && method === 'POST') {
			const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
			posts.push({ url, body });
			snapshotMem = { seq: Number(body.seq), page: body.page };
			queueMicrotask(() =>
				emit('collab.snapshot', {
					type: 'collab.snapshot',
					sub_id: `sub-${body.path}-0`,
					seq: body.seq,
					page: body.page
				})
			);
			return new Response(JSON.stringify({ seq: body.seq }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}
		if (url.includes('/v1/collab/snapshot') && method === 'GET') {
			posts.push({ url, body: null });
			return new Response(JSON.stringify(snapshotMem), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}
		if (url.includes('/v1/collab/presence') && method === 'POST') {
			posts.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
			return new Response(null, { status: 204 });
		}
		if (url.includes('/v1/fs/write')) {
			throw new Error('collab must not PUT /v1/fs/write');
		}
		return new Response('no', { status: 404 });
	});

	return {
		fetchMock: fetchMock as unknown as typeof fetch,
		posts,
		get streamsOpened() {
			return streamsOpened;
		},
		emit,
		setSnapshot(seq: number, page: KbPage | null) {
			snapshotMem = { seq, page };
		},
		onOps(handler: (body: Record<string, unknown>) => Response | Promise<Response>) {
			opsHandler = handler;
		}
	};
}

function openSession(
	h: ReturnType<typeof createHarness>,
	path: string,
	pageId = 'page-1',
	seedPage?: KbPage
) {
	return createMonitorCollabSession({
		kind: 'monitor',
		role: 'replica',
		pageId,
		schemaVersion: KB_SCHEMA_VERSION,
		clientId: 'guest',
		baseUrl: 'http://127.0.0.1:8300',
		path,
		fetchImpl: h.fetchMock,
		seedPage
	});
}

function snapshotText(page: KbPage): string {
	return page.blocks[0] && page.blocks[0].type === 'paragraph'
		? (page.blocks[0].content[0]?.text ?? '')
		: '';
}

afterEach(() => {
	clearMonitorCollabMuxForTests();
});

describe('createMonitorCollabSession', () => {
	it('sendSnapshot throws on a replica; persist is submitPage', async () => {
		const h = createHarness();
		const session = openSession(h, '/tmp/a/index.kb');
		await session.ready;
		expect(session.kind).toBe('monitor');
		expect(session.role).toBe('replica');
		await expect(session.sendSnapshot(1, paraPage('x'))).rejects.toThrow(REPLICA_SEND_SNAPSHOT_ERROR);
		await session.submitPage(0, paraPage('x'));
		expect(h.posts.some((p) => p.url.includes('/v1/fs/write'))).toBe(false);
		expect(h.posts.filter((p) => p.url.includes('/v1/collab/snapshot') && p.body)).toHaveLength(0);
		session.close();
	});

	it('multiplexes two docs on one SSE', async () => {
		const h = createHarness();
		const a = openSession(h, '/tmp/a/index.kb', 'pa');
		const b = openSession(h, '/tmp/b/index.kb', 'pb');
		await Promise.all([a.ready, b.ready]);
		expect(h.streamsOpened).toBe(1);
		expect(a.clientId).toBe(HELLO_ID);
		expect(b.clientId).toBe(HELLO_ID);
		const subPosts = h.posts.filter((p) => p.url.includes('/subs'));
		expect(subPosts.length).toBeGreaterThanOrEqual(2);
		a.close();
		b.close();
	});

	it('submitPage strips in-flight ops from the persist body', async () => {
		const h = createHarness();
		h.setSnapshot(0, paraPage(''));
		const session = openSession(h, '/tmp/a/index.kb');
		await session.ready;

		let opsCount = 0;
		let releaseOps: ((res: Response) => void) | undefined;
		h.onOps(() => {
			opsCount += 1;
			if (opsCount === 1) {
				return new Response(JSON.stringify({ seq: 1 }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
			return new Promise<Response>((resolve) => {
				releaseOps = resolve;
			});
		});

		const g1 = session.sendOps([insertOp('A')], 'g1', 0);
		const g2 = session.sendOps([insertOp('B')], 'g2', 1);
		await g1;
		await vi.waitFor(() =>
			expect(
				h.posts.some(
					(p) =>
						p.url.includes('/v1/collab/snapshot') &&
						p.body &&
						typeof p.body === 'object' &&
						(p.body as { seq?: number }).seq === 1
				)
			).toBe(true)
		);

		const snapPosts = h.posts.filter(
			(p) => p.url.includes('/v1/collab/snapshot') && p.body && typeof p.body === 'object'
		);
		const last = snapPosts[snapPosts.length - 1]!.body as { seq: number; page: KbPage };
		expect(last.seq).toBe(1);
		const text = snapshotText(last.page);
		expect(text).toBe('A');
		expect(text).not.toBe('BA');

		await session.submitPage(1, paraPage('BA'));
		const after = h.posts.filter(
			(p) => p.url.includes('/v1/collab/snapshot') && p.body && typeof p.body === 'object'
		);
		for (const row of after) {
			const body = row.body as { page: KbPage };
			const t =
				body.page.blocks[0] && body.page.blocks[0].type === 'paragraph'
					? body.page.blocks[0].content[0]?.text
					: '';
			expect(t).not.toBe('BA');
		}

		releaseOps?.(
			new Response(JSON.stringify({ seq: 2 }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		await g2;
		session.close();
	});

	it('409 wait-for-seq does not GET-replace a snapshot behind head_seq', async () => {
		const h = createHarness();
		h.setSnapshot(5, paraPage('old'));
		const session = openSession(h, '/tmp/a/index.kb');
		const frames: CollabFrame[] = [];
		session.subscribe((f) => frames.push(f));
		await session.ready;

		h.onOps(
			() =>
				new Response(JSON.stringify({ head_seq: 6 }), {
					status: 409,
					headers: { 'content-type': 'application/json' }
				})
		);

		const snap5Before = frames.filter((f) => f.kind === 'snapshot' && f.seq === 5).length;
		const send = session.sendOps([insertOp('Z')], 'lost', 5);
		await vi.waitFor(() => expect(frames.some((f) => f.kind === 'nack')).toBe(true));
		const nack = frames.find((f) => f.kind === 'nack');
		expect(nack).toMatchObject({ kind: 'nack', clientOpId: 'lost', headSeq: 6 });
		expect(frames.some((f) => f.kind === 'snapshot' && f.seq === 6)).toBe(false);
		expect(frames.filter((f) => f.kind === 'snapshot' && f.seq === 5).length).toBe(snap5Before);

		h.emit('collab.op_batch', {
			type: 'collab.op_batch',
			sub_id: 'sub-/tmp/a/index.kb-0',
			seq: 6,
			client_id: 'other-client',
			ops: [insertOp('R')]
		});
		await vi.waitFor(() => expect(frames.some((f) => f.kind === 'ops' && f.seq === 6)).toBe(true));
		expect(frames.filter((f) => f.kind === 'snapshot' && f.seq === 5).length).toBe(snap5Before);

		h.setSnapshot(6, paraPage('new'));
		h.emit('collab.snapshot', {
			type: 'collab.snapshot',
			sub_id: 'sub-/tmp/a/index.kb-0',
			seq: 6,
			page: paraPage('new')
		});
		await vi.waitFor(() => expect(frames.some((f) => f.kind === 'snapshot' && f.seq === 6)).toBe(true));
		await send;
		expect(frames.filter((f) => f.kind === 'snapshot' && f.seq === 5).length).toBe(snap5Before);
		session.close();
	});

	it('resync_required fetches a snapshot (external watch)', async () => {
		const h = createHarness();
		h.setSnapshot(1, paraPage('disk'));
		const session = openSession(h, '/tmp/a/index.kb');
		const frames: CollabFrame[] = [];
		session.subscribe((f) => frames.push(f));
		await session.ready;
		h.setSnapshot(2, paraPage('vim'));
		h.emit('collab.resync_required', {
			type: 'collab.resync_required',
			sub_id: 'sub-/tmp/a/index.kb-0',
			reason: 'external_write'
		});
		await vi.waitFor(() => expect(frames.some((f) => f.kind === 'resync')).toBe(true));
		await vi.waitFor(() =>
			expect(frames.some((f) => f.kind === 'snapshot' && f.seq === 2)).toBe(true)
		);
		session.close();
	});

	it('GET {seq:0,page:null} still POSTs snapshot after seed + winning ops', async () => {
		const h = createHarness();
		h.setSnapshot(0, null);
		const seed = paraPage('');
		const session = openSession(h, '/tmp/a/index.kb', 'page-1', seed);
		await session.ready;
		await session.sendOps([insertOp('A')], 'g1', 0);
		await vi.waitFor(() =>
			expect(
				h.posts.some(
					(p) =>
						p.url.includes('/v1/collab/snapshot') &&
						p.body &&
						typeof p.body === 'object' &&
						(p.body as { seq?: number }).seq === 1
				)
			).toBe(true)
		);
		const body = h.posts.find(
			(p) =>
				p.url.includes('/v1/collab/snapshot') &&
				p.body &&
				typeof p.body === 'object' &&
				(p.body as { seq?: number }).seq === 1
		)!.body as { page: KbPage };
		expect(snapshotText(body.page)).toBe('A');
		session.close();
	});

	it('own op_batch echo does not persist the pre-op page', async () => {
		const h = createHarness();
		h.setSnapshot(0, paraPage(''));
		const session = openSession(h, '/tmp/a/index.kb');
		await session.ready;
		await session.sendOps([insertOp('A')], 'g1', 0);
		await vi.waitFor(() =>
			expect(h.posts.some((p) => p.url.includes('/v1/collab/snapshot') && p.body)).toBe(true)
		);
		const bodies = h.posts
			.filter((p) => p.url.includes('/v1/collab/snapshot') && p.body)
			.map((p) => snapshotText((p.body as { page: KbPage }).page));
		expect(bodies.every((t) => t === 'A')).toBe(true);
		expect(bodies.some((t) => t === '')).toBe(false);
		session.close();
	});

	it('serializes sendOps so overlapping calls do not share base_seq', async () => {
		const h = createHarness();
		h.setSnapshot(0, paraPage(''));
		const session = openSession(h, '/tmp/a/index.kb');
		await session.ready;
		const p1 = session.sendOps([insertOp('A')], 'g1', 0);
		const p2 = session.sendOps([insertOp('B')], 'g2', 0);
		await Promise.all([p1, p2]);
		const opsPosts = h.posts.filter((p) => p.url.includes('/v1/collab/ops'));
		expect(opsPosts.map((p) => (p.body as { base_seq: number }).base_seq)).toEqual([0, 1]);
		session.close();
	});

	it('409 recovery waits for localSeq >= headSeq (not strict equality)', async () => {
		const h = createHarness();
		h.setSnapshot(5, paraPage('old'));
		const session = openSession(h, '/tmp/a/index.kb');
		const frames: CollabFrame[] = [];
		session.subscribe((f) => frames.push(f));
		await session.ready;
		h.onOps(
			() =>
				new Response(JSON.stringify({ head_seq: 6 }), {
					status: 409,
					headers: { 'content-type': 'application/json' }
				})
		);
		const send = session.sendOps([insertOp('Z')], 'lost', 5);
		await vi.waitFor(() => expect(frames.some((f) => f.kind === 'nack')).toBe(true));
		h.emit('collab.op_batch', {
			type: 'collab.op_batch',
			sub_id: 'sub-/tmp/a/index.kb-0',
			seq: 6,
			client_id: 'other-client',
			ops: [insertOp('R')]
		});
		h.emit('collab.op_batch', {
			type: 'collab.op_batch',
			sub_id: 'sub-/tmp/a/index.kb-0',
			seq: 7,
			client_id: 'other-client',
			ops: [insertOp('S')]
		});
		h.setSnapshot(7, paraPage('caught-up'));
		h.emit('collab.snapshot', {
			type: 'collab.snapshot',
			sub_id: 'sub-/tmp/a/index.kb-0',
			seq: 7,
			page: paraPage('caught-up')
		});
		await vi.waitFor(() => expect(frames.some((f) => f.kind === 'snapshot' && f.seq === 7)).toBe(true));
		await send;
		session.close();
	});

	it('seedMonitorSessionPage enables persist when join snapshot is empty', async () => {
		const h = createHarness();
		h.setSnapshot(0, null);
		const session = openSession(h, '/tmp/a/index.kb');
		await session.ready;
		seedMonitorSessionPage(session, paraPage(''));
		await session.sendOps([insertOp('Z')], 'g1', 0);
		await vi.waitFor(() =>
			expect(
				h.posts.some(
					(p) =>
						p.url.includes('/v1/collab/snapshot') &&
						typeof p.body === 'object' &&
						p.body &&
						(p.body as { seq?: number }).seq === 1
				)
			).toBe(true)
		);
		session.close();
	});

	it('does not open WebSocket/EventSource or PUT /v1/fs/write', () => {
		expect(src).not.toMatch(/new\s+WebSocket\b/);
		expect(src).not.toMatch(/new\s+EventSource\b/);
		expect(src).not.toMatch(/\/v1\/fs\/write/);
		expect(src).toMatch(/REPLICA_SEND_SNAPSHOT_ERROR/);
		expect(src).not.toMatch(/from '@shared-packages\/git'/);
	});
});

describe('submit gates', () => {
	it('winner or no-in-flight replica may submit; others skip', () => {
		expect(maySubmitMonitorPage({ seq: 3, wonSeq: 3, appliedSeq: 3, inFlightCount: 1 })).toBe(true);
		expect(maySubmitMonitorPage({ seq: 3, wonSeq: null, appliedSeq: 3, inFlightCount: 0 })).toBe(
			true
		);
		expect(maySubmitMonitorPage({ seq: 3, wonSeq: null, appliedSeq: 3, inFlightCount: 1 })).toBe(
			false
		);
		expect(maySubmitMonitorPage({ seq: 3, wonSeq: 2, appliedSeq: 2, inFlightCount: 0 })).toBe(false);
	});

	it('stripInFlightPage keeps the acked prefix', () => {
		const acked = paraPage('ack');
		const live = paraPage('live');
		expect(stripInFlightPage(live, acked, 1)).toEqual(acked);
		expect(stripInFlightPage(live, acked, 0)).toEqual(live);
	});
});
