import { describe, expect, it, vi } from 'vitest';
import { createMonitorWatchStream } from './watchStream.js';
import type { MonitorSubsRequest, MonitorSubsResult, MonitorTransport } from './client.js';

/**
 * A monitor stand-in: an SSE stream over `fetch`, plus a transport whose
 * `watchUpdateSubs` answers on the stream the way the server does.
 */
function createHarness() {
	const encoder = new TextEncoder();
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let streamsOpened = 0;

	const emit = (event: string, data: unknown) => {
		controller?.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
	};

	const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
		if (!String(url).includes('/v1/watch/events')) {
			return new Response('{}', { status: 200 });
		}
		streamsOpened += 1;
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
			cancel() {
				controller = null;
			}
		});
		init?.signal?.addEventListener('abort', () => {
			try {
				controller?.error(new DOMException('aborted', 'AbortError'));
			} catch {
				/* already closed */
			}
			controller = null;
		});
		// The server greets every stream with its client_id.
		queueMicrotask(() => emit('watch.hello', { type: 'watch.hello', client_id: 'client-1' }));
		return new Response(stream, {
			status: 200,
			headers: { 'content-type': 'text/event-stream' }
		});
	});

	const subs = new Map<string, string>(); // root_id → sub_id
	let subCounter = 0;

	const watchAddRoot = vi.fn(async (path: string, _recursive?: boolean) => ({
		root_id: `root:${path}`,
		path
	}));

	const watchUpdateSubs = vi.fn(async (req: MonitorSubsRequest): Promise<MonitorSubsResult> => {
		const unsubscribed = (req.unsubscribe ?? []).map((rootId) => {
			const subId = subs.get(rootId) ?? 'unknown';
			subs.delete(rootId);
			emit('watch.unsubscribed', { type: 'watch.unsubscribed', sub_id: subId, root_id: rootId });
			return { root_id: rootId, sub_id: subId };
		});
		const subscribed = (req.subscribe ?? []).map(({ rootId }) => {
			const subId = subs.get(rootId) ?? `sub-${++subCounter}`;
			subs.set(rootId, subId);
			const entry = { root_id: rootId, sub_id: subId, path: rootId.replace(/^root:/, '') };
			emit('watch.subscribed', { type: 'watch.subscribed', ...entry });
			return entry;
		});
		return { subscribed, unsubscribed };
	});

	const watchRemoveRoot = vi.fn(async (_rootId: string, _force?: boolean) => {});

	const transport = {
		baseUrl: 'http://127.0.0.1:8300',
		watchAddRoot,
		watchUpdateSubs,
		watchRemoveRoot,
		list: vi.fn(),
		stat: vi.fn(),
		download: vi.fn(),
		health: vi.fn(),
		watchListRoots: vi.fn()
	} as unknown as MonitorTransport;

	return {
		transport,
		fetchImpl: fetchMock as unknown as typeof fetch,
		watchAddRoot,
		watchUpdateSubs,
		watchRemoveRoot,
		emit,
		subIdFor: (path: string) => subs.get(`root:${path}`),
		closeStream: () => {
			controller?.close();
			controller = null;
		},
		streamsOpened: () => streamsOpened
	};
}

const batch = (subId: string) => ({
	type: 'watch.event_batch',
	sub_id: subId,
	seq: 1,
	events: [{ kind: 'create', path: '/x', rel_path: 'x', is_dir: false }]
});

describe('createMonitorWatchStream', () => {
	it('watches the folder itself, non-recursively', async () => {
		const h = createHarness();
		const stream = createMonitorWatchStream({
			transport: h.transport,
			fetchImpl: h.fetchImpl,
			debounceMs: 10
		});
		const onChange = vi.fn();
		stream.watchFolder('/home/me/project', onChange);

		await vi.waitFor(() => expect(h.watchAddRoot).toHaveBeenCalled());
		// Recursive would cost inotify descriptors for the whole subtree.
		expect(h.watchAddRoot).toHaveBeenCalledWith('/home/me/project', false);

		// `subscribed` is the resync point — the folder may have changed while
		// nothing was watching it.
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
		stream.stop();
	});

	it('stop() releases every root it created, so the daemon does not leak them', async () => {
		// The daemon drops a root ONLY on an explicit DELETE — never on client
		// disconnect or stream close (roots are process-global, unowned, unreaped).
		// Before this was wired up, each browsed folder leaked a root for the
		// daemon's lifetime; at `max_roots` (16) every new subscription failed and
		// live updates silently stopped working. Regression-guard that teardown.
		const h = createHarness();
		const stream = createMonitorWatchStream({
			transport: h.transport,
			fetchImpl: h.fetchImpl,
			debounceMs: 10
		});
		stream.watchFolder('/home/me/a', vi.fn());
		stream.watchFolder('/home/me/b', vi.fn());
		await vi.waitFor(() => expect(h.watchAddRoot).toHaveBeenCalledTimes(2));

		stream.stop();

		await vi.waitFor(() => expect(h.watchRemoveRoot).toHaveBeenCalledTimes(2));
		const released = h.watchRemoveRoot.mock.calls.map((c) => c[0]).sort();
		expect(released).toEqual(['root:/home/me/a', 'root:/home/me/b']);
	});

	it('multiplexes several folders over one connection, routed by sub_id', async () => {
		const h = createHarness();
		const stream = createMonitorWatchStream({
			transport: h.transport,
			fetchImpl: h.fetchImpl,
			debounceMs: 10
		});
		const onA = vi.fn();
		const onB = vi.fn();
		stream.watchFolder('/a', onA);
		stream.watchFolder('/b', onB);

		await vi.waitFor(() => {
			expect(h.subIdFor('/a')).toBeTruthy();
			expect(h.subIdFor('/b')).toBeTruthy();
		});
		// One SSE connection for both folders: the browser only has ~6 per origin.
		expect(h.streamsOpened()).toBe(1);

		onA.mockClear();
		onB.mockClear();
		h.emit('watch.event_batch', batch(h.subIdFor('/a')!));
		await vi.waitFor(() => expect(onA).toHaveBeenCalled());
		expect(onB).not.toHaveBeenCalled();
		const passed = onA.mock.calls.at(-1)?.[0] as Array<{ kind: string; path?: string }>;
		expect(passed?.[0]?.kind).toBe('create');
		expect(passed?.[0]?.path).toBe('/x');

		onA.mockClear();
		h.emit('watch.event_batch', batch(h.subIdFor('/b')!));
		await vi.waitFor(() => expect(onB).toHaveBeenCalled());
		expect(onA).not.toHaveBeenCalled();

		stream.stop();
	});

	it('leaving a folder keeps it briefly, so back-navigation costs nothing', async () => {
		const h = createHarness();
		const stream = createMonitorWatchStream({
			transport: h.transport,
			fetchImpl: h.fetchImpl,
			debounceMs: 10,
			holdMs: 10_000
		});
		const onA = vi.fn();
		const release = stream.watchFolder('/a', onA);
		await vi.waitFor(() => expect(h.subIdFor('/a')).toBeTruthy());

		const callsBefore = h.watchUpdateSubs.mock.calls.length;
		release();
		expect(stream.watchedPaths()).toContain('/a');

		// Re-entering inside the hold window reuses the live subscription.
		const onAgain = vi.fn();
		stream.watchFolder('/a', onAgain);
		await new Promise((r) => setTimeout(r, 30));
		expect(h.watchUpdateSubs.mock.calls.length).toBe(callsBefore);

		h.emit('watch.event_batch', batch(h.subIdFor('/a')!));
		await vi.waitFor(() => expect(onAgain).toHaveBeenCalled());
		stream.stop();
	});

	it('releases a folder once the hold expires', async () => {
		const h = createHarness();
		const stream = createMonitorWatchStream({
			transport: h.transport,
			fetchImpl: h.fetchImpl,
			debounceMs: 10,
			holdMs: 30
		});
		const release = stream.watchFolder('/a', vi.fn());
		await vi.waitFor(() => expect(h.subIdFor('/a')).toBeTruthy());

		release();
		await vi.waitFor(() => expect(h.subIdFor('/a')).toBeUndefined(), { timeout: 1_000 });
		expect(stream.watchedPaths()).not.toContain('/a');
		stream.stop();
	});

	it('re-subscribes everything after a reconnect', async () => {
		const h = createHarness();
		const stream = createMonitorWatchStream({
			transport: h.transport,
			fetchImpl: h.fetchImpl,
			debounceMs: 10,
			maxReconnectDelayMs: 50
		});
		const onA = vi.fn();
		stream.watchFolder('/a', onA);
		await vi.waitFor(() => expect(h.subIdFor('/a')).toBeTruthy());

		onA.mockClear();
		h.closeStream();

		// A reconnect is a full resync: the server keeps no replay buffer, so the
		// folder must be re-read rather than trusted.
		await vi.waitFor(() => expect(h.streamsOpened()).toBe(2), { timeout: 2_000 });
		await vi.waitFor(() => expect(onA).toHaveBeenCalled(), { timeout: 2_000 });
		expect(h.subIdFor('/a')).toBeTruthy();
		stream.stop();
	});

	it('coalesces a burst on one folder into a single refresh', async () => {
		const h = createHarness();
		const stream = createMonitorWatchStream({
			transport: h.transport,
			fetchImpl: h.fetchImpl,
			debounceMs: 40,
			maxDebounceMs: 200
		});
		const onA = vi.fn();
		stream.watchFolder('/a', onA);
		await vi.waitFor(() => expect(h.subIdFor('/a')).toBeTruthy());
		await vi.waitFor(() => expect(onA).toHaveBeenCalled());
		onA.mockClear();

		const subId = h.subIdFor('/a')!;
		for (let i = 0; i < 5; i += 1) h.emit('watch.event_batch', batch(subId));
		await vi.waitFor(() => expect(onA).toHaveBeenCalledTimes(1));
		await new Promise((r) => setTimeout(r, 80));
		expect(onA).toHaveBeenCalledTimes(1);
		stream.stop();
	});

	it('stop() ends the stream and reports closed', async () => {
		const h = createHarness();
		const stream = createMonitorWatchStream({
			transport: h.transport,
			fetchImpl: h.fetchImpl,
			debounceMs: 10
		});
		stream.watchFolder('/a', vi.fn());
		await vi.waitFor(() => expect(h.subIdFor('/a')).toBeTruthy());

		stream.stop();
		expect(stream.getStatus()).toBe('closed');
		expect(stream.watchedPaths()).toEqual([]);

		// No reconnect after stop.
		const opened = h.streamsOpened();
		await new Promise((r) => setTimeout(r, 120));
		expect(h.streamsOpened()).toBe(opened);
	});
});
