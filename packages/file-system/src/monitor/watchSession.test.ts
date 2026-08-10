import { describe, expect, it, vi, beforeEach } from 'vitest';
import { startWatchSession } from './watchSession.js';

/**
 * Mock fetch that simulates an SSE stream.
 * Returns a Response with a ReadableStream that emits SSE events.
 */
type MockFetch = ReturnType<typeof vi.fn> & {
	_emit?: (event: string, data: unknown) => void;
	_close?: () => void;
	_controller?: ReadableStreamDefaultController<Uint8Array> | null;
};

function createMockFetch(events: Array<{ event: string; data: unknown }>) {
	const encoder = new TextEncoder();
	let eventIndex = 0;
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
			// Emit all events immediately
			for (const ev of events) {
				const chunk = `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
				c.enqueue(encoder.encode(chunk));
			}
		},
		cancel() {
			controller = null;
		}
	});

	const fetchMock: MockFetch = vi.fn(async (url: string | URL) => {
		const urlStr = String(url);
		if (urlStr.includes('/v1/watch/events')) {
			return new Response(stream, {
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
			});
		}
		return new Response('{}', { status: 200 });
	});

	fetchMock._controller = controller;
	return fetchMock;
}

/** Mock fetch that simulates a stream that stays open and emits events later. */
function createControllableFetch() {
	const encoder = new TextEncoder();
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

	const fetchMock: MockFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
		const urlStr = String(url);
		if (urlStr.includes('/v1/watch/events')) {
			// Create a fresh stream for each SSE connection
			const stream = new ReadableStream<Uint8Array>({
				start(c) {
					controller = c;
				},
				cancel() {
					controller = null;
				}
			});
			// If aborted, reject (simulates real fetch abort behavior)
			if (init?.signal?.aborted) {
				throw new DOMException('The user aborted a request.', 'AbortError');
			}
			// Listen for abort → error the stream (simulates real fetch abort)
			init?.signal?.addEventListener('abort', () => {
				if (controller) {
					controller.error(new DOMException('aborted', 'AbortError'));
					controller = null;
				}
			});
			return new Response(stream, {
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
			});
		}
		return new Response('{}', { status: 200 });
	});

	fetchMock._emit = (event: string, data: unknown) => {
		if (!controller) return;
		const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
		controller.enqueue(encoder.encode(chunk));
	};
	fetchMock._close = () => {
		controller?.close();
		controller = null;
	};
	return fetchMock;
}

describe('startWatchSession', () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	it('ensures root, subscribes via fetch SSE, fires onChange on event_batch', async () => {
		const fetchMock = createControllableFetch();
		const onChange = vi.fn();
		const statuses: string[] = [];
		const ensureRoot = vi.fn(async () => ({ root_id: 'root-1', path: '/tmp' }));

		const session = startWatchSession({
			baseUrl: 'http://127.0.0.1:8300',
			rootPath: '/tmp',
			ensureRoot,
			onChange,
			onStatus: (s) => statuses.push(s),
			debounceMs: 10,
			fetchImpl: fetchMock as unknown as typeof fetch,
		});

		await vi.waitFor(() => expect(ensureRoot).toHaveBeenCalled());

		// Emit hello + subscribed
		fetchMock._emit!('watch.hello', { type: 'watch.hello', client_id: 'c1' });
		fetchMock._emit!('watch.subscribed', { type: 'watch.subscribed', sub_id: 's1', root_id: 'root-1' });

		await vi.waitFor(() => statuses.includes('subscribed'));

		// Verify the SSE URL includes root_id query param
		const sseCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/v1/watch/events'));
		expect(sseCall).toBeTruthy();
		expect(String(sseCall![0])).toContain('root_id=root-1');

		// Emit event_batch
		onChange.mockClear();
		fetchMock._emit!('watch.event_batch', {
			type: 'watch.event_batch',
			sub_id: 's1',
			seq: 1,
			events: [{ kind: 'create', path: '/tmp/x', rel_path: 'x', is_dir: false }],
		});
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled());

		// No ack round trip: the endpoint is gone, and each POST would have cost a
		// CORS preflight per batch for no server-side effect.
		expect(
			fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/watch/ack'))
		).toBe(false);

		// Loopback requests carry the Local Network Access annotation.
		expect((sseCall![1] as { targetAddressSpace?: string }).targetAddressSpace).toBe('local');

		session.stop();
		expect(session.getStatus()).toBe('closed');
	});

	it('reconnects after stream ends', async () => {
		const fetchMock = createControllableFetch();
		const ensureRoot = vi.fn(async () => ({ root_id: 'root-1', path: '/tmp' }));

		const session = startWatchSession({
			baseUrl: 'http://127.0.0.1:8300',
			rootPath: '/tmp',
			ensureRoot,
			onChange: vi.fn(),
			debounceMs: 10,
			fetchImpl: fetchMock as unknown as typeof fetch,
		});

		await vi.waitFor(() => expect(ensureRoot).toHaveBeenCalled());

		// Emit hello + subscribed
		fetchMock._emit!('watch.hello', { type: 'watch.hello' });
		fetchMock._emit!('watch.subscribed', { type: 'watch.subscribed', sub_id: 's1' });

		// Close the stream — should trigger reconnect
		fetchMock._close!();

		// Wait for reconnect — ensureRoot called again
		await vi.waitFor(() => expect(ensureRoot).toHaveBeenCalledTimes(2), { timeout: 5000 });

		session.stop();
	});

	it('watchdog forces reconnect when no data arrives', async () => {
		const fetchMock = createControllableFetch();
		const ensureRoot = vi.fn(async () => ({ root_id: 'root-1', path: '/tmp' }));

		const session = startWatchSession({
			baseUrl: 'http://127.0.0.1:8300',
			rootPath: '/tmp',
			ensureRoot,
			onChange: vi.fn(),
			debounceMs: 10,
			watchdogMs: 100, // very short for test speed
			fetchImpl: fetchMock as unknown as typeof fetch,
		});

		// Initial connection
		await vi.waitFor(() => expect(ensureRoot).toHaveBeenCalledTimes(1));

		// Watchdog fires after 100ms with no data → abort → reconnect
		// Reconnect backoff: 500ms first attempt
		await vi.waitFor(() => expect(ensureRoot).toHaveBeenCalledTimes(2), { timeout: 5000 });

		session.stop();
	});

	it('treats resync_required as a local refetch, with no POST back', async () => {
		const fetchMock = createControllableFetch();
		const onChange = vi.fn();
		const ensureRoot = vi.fn(async () => ({ root_id: 'root-1', path: '/tmp' }));

		const session = startWatchSession({
			baseUrl: 'http://127.0.0.1:8300',
			rootPath: '/tmp',
			ensureRoot,
			onChange,
			debounceMs: 10,
			fetchImpl: fetchMock as unknown as typeof fetch,
		});

		await vi.waitFor(() => expect(ensureRoot).toHaveBeenCalled());
		fetchMock._emit!('watch.hello', { type: 'watch.hello' });
		fetchMock._emit!('watch.subscribed', { type: 'watch.subscribed', sub_id: 's1' });
		await vi.waitFor(() => session.getStatus() === 'subscribed');

		fetchMock._emit!('watch.resync_required', {
			type: 'watch.resync_required',
			sub_id: 's1',
			reason: 'BufferOverflow',
		});

		// Refetching current state *is* the resync — nothing is sent back.
		await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
		expect(session.getStatus()).toBe('resync');
		expect(
			fetchMock.mock.calls.some((c) => String(c[0]).includes('/v1/watch/resync'))
		).toBe(false);

		session.stop();
	});

	it('gives up after maxReconnectAttempts instead of retrying forever', async () => {
		// A monitor that is down stays down; an uncapped loop would keep firing a
		// local-network request (and its LNA prompt) for the life of the tab.
		const ensureRoot = vi.fn(async (): Promise<{ root_id: string; path: string }> => {
			throw new Error('connection refused');
		});
		const statuses: string[] = [];

		const session = startWatchSession({
			baseUrl: 'http://127.0.0.1:8300',
			rootPath: '/tmp',
			ensureRoot,
			onChange: vi.fn(),
			onStatus: (s) => statuses.push(s),
			debounceMs: 10,
			maxReconnectAttempts: 3,
			maxReconnectDelayMs: 20,
			fetchImpl: vi.fn(
				async () => new Response('{}', { status: 200 })
			) as unknown as typeof fetch,
		});

		// 1 initial attempt + 3 retries, then it stops trying.
		await vi.waitFor(() => expect(ensureRoot).toHaveBeenCalledTimes(4), { timeout: 5000 });
		const settled = ensureRoot.mock.calls.length;
		await new Promise((r) => setTimeout(r, 250));
		expect(ensureRoot).toHaveBeenCalledTimes(settled);
		expect(statuses.at(-1)).toBe('error');

		session.stop();
	});
});
