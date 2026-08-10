/**
 * Browser-side watch via fetch-based SSE for monitor live list refresh.
 *
 * Consumes the SSE stream with `fetch()` + `ReadableStream` rather than
 * `EventSource`, because only `fetch` accepts `targetAddressSpace: 'local'` —
 * the annotation that lets an HTTPS page reach loopback under a single Local
 * Network Access grant instead of a warning per request. See `./localNetwork`.
 * (Neither transport is blocked as mixed content: loopback is a potentially
 * trustworthy origin, so it is exempt from mixed-content blocking entirely.)
 *
 * Flow:
 * 1. `ensureRoot` (POST /v1/watch/roots) → get root_id
 * 2. `fetch()` GET /v1/watch/events?root_id=X → read SSE stream via ReadableStream
 * 3. Server sends `watch.hello`, `watch.subscribed`, then `watch.event_batch`
 * 4. On stream end/error: reconnect with exponential backoff + jitter
 * 5. Watchdog: if no data in 30s, force reconnect (detects zombie connections)
 *
 * The stream is fire-and-forget — there are no acks. The server keeps no replay
 * buffer, so a gap is unrecoverable by design and **every (re)connect is a full
 * resync**: `watch.subscribed` fires `onChange`, which re-reads current state.
 */
import { withLocalAddressSpace } from './localNetwork';

export type WatchedRoot = {
	root_id: string;
	path: string;
	recursive?: boolean;
};

export type WatchSessionOptions = {
	/** e.g. http://127.0.0.1:8300 */
	baseUrl: string;
	/** Absolute host directory to watch (same as browse root) */
	rootPath: string;
	/** Add/ensure watch root via proxied REST */
	ensureRoot: (path: string, recursive?: boolean) => Promise<WatchedRoot>;
	/** Debounced when events arrive */
	onChange: () => void;
	debounceMs?: number;
	/** Optional status for UI / e2e */
	onStatus?: (status: WatchSessionStatus) => void;
	/** fetch implementation (tests) */
	fetchImpl?: typeof fetch;
	/** Heartbeat watchdog timeout (default 30s — force reconnect if no data) */
	watchdogMs?: number;
	/** Give up after this many consecutive failed reconnects (default 12). */
	maxReconnectAttempts?: number;
	/** Backoff ceiling before jitter (default 10s). */
	maxReconnectDelayMs?: number;
};

export type WatchSessionStatus =
	| 'connecting'
	| 'subscribed'
	| 'resync'
	| 'error'
	| 'closed';

export type WatchSession = {
	stop: () => void;
	/** Last known status */
	getStatus: () => WatchSessionStatus;
};

/** Build the SSE URL: `${baseUrl}/v1/watch/events?root_id=X` */
function toSseUrl(httpBase: string, rootId: string): string {
	const u = new URL(httpBase.endsWith('/') ? httpBase : httpBase + '/');
	u.pathname = '/v1/watch/events';
	u.search = `?root_id=${encodeURIComponent(rootId)}`;
	u.hash = '';
	return u.toString();
}

/**
 * Parse SSE text chunk into events.
 * SSE format: `event: <type>\ndata: <json>\n\n`
 * Returns array of { event, data } pairs.
 */
function parseSseChunk(text: string): Array<{ event: string; data: string }> {
	const events: Array<{ event: string; data: string }> = [];
	const blocks = text.split('\n\n');
	for (const block of blocks) {
		if (!block.trim()) continue;
		let event = 'message';
		let data = '';
		for (const line of block.split('\n')) {
			if (line.startsWith('event:')) {
				event = line.slice(6).trim();
			} else if (line.startsWith('data:')) {
				data = line.slice(5).trim();
			}
			// Ignore comments (lines starting with `:`) and other fields
		}
		if (data) {
			events.push({ event, data });
		}
	}
	return events;
}

/**
 * Ensure root is watched, open fetch-based SSE stream, fan out debounced onChange.
 * Self-healing: reconnect with backoff + watchdog for zombie connections.
 */
export function startWatchSession(opts: WatchSessionOptions): WatchSession {
	const debounceMs = opts.debounceMs ?? 150;
	const watchdogMs = opts.watchdogMs ?? 30_000;
	const maxReconnectAttempts = opts.maxReconnectAttempts ?? 12;
	const maxReconnectDelayMs = opts.maxReconnectDelayMs ?? 10_000;
	const fetchFn = opts.fetchImpl ?? fetch;
	let status: WatchSessionStatus = 'connecting';
	let stopped = false;
	let abortController: AbortController | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let reconnectAttempt = 0;

	const setStatus = (s: WatchSessionStatus) => {
		status = s;
		opts.onStatus?.(s);
	};

	const fireChange = () => {
		if (stopped) return;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			if (!stopped) opts.onChange();
		}, debounceMs);
	};

	const clearTimers = () => {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		if (watchdogTimer) {
			clearTimeout(watchdogTimer);
			watchdogTimer = null;
		}
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
	};

	/** Reset the heartbeat watchdog. If no data in `watchdogMs`, force reconnect. */
	const resetWatchdog = () => {
		if (watchdogTimer) clearTimeout(watchdogTimer);
		if (stopped) return;
		watchdogTimer = setTimeout(() => {
			if (stopped) return;
			console.warn('[monitor watch] watchdog timeout — forcing reconnect');
			abortController?.abort();
		}, watchdogMs);
	};

	/** Handle a parsed SSE event. */
	const handleEvent = (type: string, data: string) => {
		if (stopped) return;
		resetWatchdog();

		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(data) as Record<string, unknown>;
		} catch {
			return;
		}

		if (type === 'watch.hello') {
			return;
		}
		if (type === 'watch.subscribed') {
			// Every (re)connect is a full resync — refetch before trusting deltas.
			setStatus('subscribed');
			fireChange();
			return;
		}
		if (type === 'watch.event_batch') {
			fireChange();
			return;
		}
		if (type === 'watch.resync_required') {
			// Nothing to send back: refetching current state *is* the resync.
			setStatus('resync');
			fireChange();
			return;
		}
		if (type === 'watch.resync_begin') {
			setStatus('subscribed');
			fireChange();
			return;
		}
		if (type === 'watch.error') {
			setStatus('error');
			return;
		}
	};

	const connect = async () => {
		if (stopped) return;
		setStatus('connecting');

		// Ensure root exists (POST /v1/watch/roots).
		// Try recursive first; fall back to non-recursive if the inotify
		// descriptor budget is exceeded (large directory trees).
		let root: WatchedRoot;
		try {
			root = await opts.ensureRoot(opts.rootPath, true);
		} catch (e) {
			const errMsg = e instanceof Error ? e.message : String(e);
			if (errMsg.includes('inotify_budget') || errMsg.includes('would exceed max_watch_descriptors')) {
				console.warn('[monitor watch] recursive watch exceeded descriptor budget, falling back to non-recursive');
				try {
					root = await opts.ensureRoot(opts.rootPath, false);
				} catch (e2) {
					setStatus('error');
					console.warn('[monitor watch] ensureRoot (non-recursive) failed', e2);
					scheduleReconnect();
					return;
				}
			} else {
				setStatus('error');
				console.warn('[monitor watch] ensureRoot failed', e);
				scheduleReconnect();
				return;
			}
		}
		if (stopped) return;

		const url = toSseUrl(opts.baseUrl, root.root_id);
		abortController = new AbortController();

		try {
			const res = await fetchFn(url, withLocalAddressSpace(url, {
				method: 'GET',
				headers: { accept: 'text/event-stream' },
				signal: abortController.signal,
			}));

			if (!res.ok) {
				throw new Error(`SSE connect failed: ${res.status} ${res.statusText}`);
			}

			if (!res.body) {
				throw new Error('SSE connect failed: no response body');
			}

			reconnectAttempt = 0;
			resetWatchdog();

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (!stopped) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				// Process complete SSE blocks (separated by \n\n)
				const blocks = buffer.split('\n\n');
				// Keep the last incomplete block in buffer
				buffer = blocks.pop() ?? '';

				for (const block of blocks) {
					if (!block.trim()) continue;
					const events = parseSseChunk(block);
					for (const ev of events) {
						handleEvent(ev.event, ev.data);
					}
				}
			}
		} catch (e) {
			if (stopped) return;
			if (e instanceof DOMException && e.name === 'AbortError') {
				// Watchdog or stop() triggered abort — not an error
			} else {
				console.warn('[monitor watch] stream error', e);
			}
		} finally {
			if (watchdogTimer) {
				clearTimeout(watchdogTimer);
				watchdogTimer = null;
			}
		}

		if (!stopped) {
			setStatus('closed');
			scheduleReconnect();
		}
	};

	const scheduleReconnect = () => {
		if (stopped) return;
		if (reconnectAttempt >= maxReconnectAttempts) {
			// A monitor that is down stays down; retrying forever means a request
			// (and a Local Network Access prompt/warning) every cap interval for the
			// life of the tab. Give up visibly and let the user reconnect.
			console.warn(
				`[monitor watch] giving up after ${reconnectAttempt} reconnect attempts`
			);
			setStatus('error');
			return;
		}
		const backoff = Math.min(maxReconnectDelayMs, 500 * 2 ** reconnectAttempt);
		// Jitter so multiple panes watching the same monitor don't retry in lockstep.
		const delay = backoff / 2 + Math.random() * (backoff / 2);
		reconnectAttempt += 1;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			void connect();
		}, delay);
	};

	void connect();

	return {
		stop() {
			stopped = true;
			clearTimers();
			setStatus('closed');
			abortController?.abort();
			abortController = null;
		},
		getStatus() {
			return status;
		}
	};
}
