/**
 * Browser-side watch: one SSE connection, many watched folders.
 *
 * Consumes the SSE stream with `fetch()` + `ReadableStream` rather than
 * `EventSource`, because only `fetch` accepts `targetAddressSpace` — the
 * annotation that lets an HTTPS page reach loopback under a single Local
 * Network Access grant instead of a warning per request. See `./localNetwork`.
 * (Neither transport is blocked as mixed content: loopback is a potentially
 * trustworthy origin, so it is exempt from mixed-content blocking entirely.)
 *
 * **Why one connection.** A browser allows roughly six concurrent HTTP/1.1
 * connections per origin and an SSE stream holds one open for as long as it
 * lives. A stream per watched folder would let a dual-pane view or an
 * expandable tree spend the whole budget on watching and starve `list`, `stat`
 * and `download` on the same origin. Every folder is therefore multiplexed onto
 * one stream and demultiplexed by `sub_id`.
 *
 * **Why per-folder.** Watching the profile root recursively costs inotify
 * descriptors proportional to the whole subtree — the monitor has a
 * `max_watch_descriptors` budget it visibly falls off — and delivers events for
 * thousands of files nobody is looking at. A non-recursive subscription on the
 * folder actually on screen is O(1) descriptors and arrives pre-filtered.
 *
 * Flow:
 * 1. `GET /v1/watch/events` with no roots → `watch.hello` carries `client_id`
 * 2. `POST /v1/watch/roots` per folder (non-recursive) → `root_id`
 * 3. `POST /v1/watch/subs` with that `client_id` → `watch.subscribed` per folder
 * 4. `watch.event_batch` frames are routed to a folder by `sub_id`
 * 5. Navigating changes the set through step 3 alone: the connection, and every
 *    folder that stayed, are undisturbed
 *
 * Delivery contract — **every (re)connect is a full resync.** The server keeps
 * no replay buffer, so a gap is unrecoverable by design: `watch.subscribed`
 * fires the folder's listeners, which re-read current state.
 */
import type { MonitorTransport } from './client.js';
import { createCoalescer, type Coalescer } from './coalesce.js';
import { withLocalAddressSpace } from './localNetwork.js';

export type WatchStreamStatus = 'connecting' | 'subscribed' | 'resync' | 'error' | 'closed';

export type MonitorWatchStreamOptions = {
	transport: MonitorTransport;
	/** Coalescing quiet period per folder (default 120ms). */
	debounceMs?: number;
	/** Ceiling on coalescing delay per folder (default 1s). */
	maxDebounceMs?: number;
	/** Optional status for UI / e2e. */
	onStatus?: (status: WatchStreamStatus) => void;
	/** fetch implementation (tests). */
	fetchImpl?: typeof fetch;
	/** Heartbeat watchdog (default 30s — force reconnect if no data). */
	watchdogMs?: number;
	/**
	 * How long a folder keeps its subscription after its last listener leaves
	 * (default 15s). Browsing in and out of folders would otherwise churn
	 * `POST /v1/watch/roots` + `/subs` on every step, and back-navigation is
	 * common enough to be worth holding for.
	 */
	holdMs?: number;
	/** Give up after this many consecutive failed reconnects (default 12). */
	maxReconnectAttempts?: number;
	/** Backoff ceiling before jitter (default 10s). */
	maxReconnectDelayMs?: number;
};

export type MonitorWatchStream = {
	/**
	 * Watch `path` (an absolute host directory) until the returned function is
	 * called. Several callers may watch the same folder; the subscription is
	 * shared and only released when the last one leaves.
	 */
	watchFolder(path: string, listener: () => void): () => void;
	getStatus(): WatchStreamStatus;
	/** Absolute paths currently subscribed or held (tests / diagnostics). */
	watchedPaths(): string[];
	stop(): void;
};

/** One watched folder. */
type FolderState = {
	path: string;
	listeners: Set<() => void>;
	rootId: string | null;
	subId: string | null;
	/** Deadline after which an unreferenced folder is released; null while in use. */
	releaseAt: number | null;
	coalescer: Coalescer;
};

/**
 * Parse an SSE text chunk into events.
 * SSE format: `event: <type>\ndata: <json>\n\n`
 */
export function parseSseChunk(text: string): Array<{ event: string; data: string }> {
	const events: Array<{ event: string; data: string }> = [];
	for (const block of text.split('\n\n')) {
		if (!block.trim()) continue;
		let event = 'message';
		let data = '';
		for (const line of block.split('\n')) {
			if (line.startsWith('event:')) {
				event = line.slice(6).trim();
			} else if (line.startsWith('data:')) {
				data = line.slice(5).trim();
			}
			// Ignore comments (lines starting with `:`) and other fields.
		}
		if (data) events.push({ event, data });
	}
	return events;
}

export function createMonitorWatchStream(
	opts: MonitorWatchStreamOptions
): MonitorWatchStream {
	const transport = opts.transport;
	const debounceMs = opts.debounceMs ?? 120;
	const maxDebounceMs = opts.maxDebounceMs ?? 1_000;
	const watchdogMs = opts.watchdogMs ?? 30_000;
	const holdMs = opts.holdMs ?? 15_000;
	const maxReconnectAttempts = opts.maxReconnectAttempts ?? 12;
	const maxReconnectDelayMs = opts.maxReconnectDelayMs ?? 10_000;
	const fetchFn = opts.fetchImpl ?? fetch;

	const folders = new Map<string, FolderState>();
	let status: WatchStreamStatus = 'connecting';
	let stopped = false;
	let clientId: string | null = null;
	let abortController: AbortController | null = null;
	let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let sweepTimer: ReturnType<typeof setTimeout> | null = null;
	let reconnectAttempt = 0;
	let connecting = false;
	/** Serializes `POST /v1/watch/subs`; a second request while one is in flight re-runs after. */
	let syncing = false;
	let syncAgain = false;

	const setStatus = (s: WatchStreamStatus) => {
		status = s;
		opts.onStatus?.(s);
	};

	const notify = (folder: FolderState) => {
		for (const l of folder.listeners) {
			try {
				l();
			} catch {
				/* a listener's failure is not the stream's problem */
			}
		}
	};

	const folderBySubId = (subId: string): FolderState | undefined => {
		for (const f of folders.values()) {
			if (f.subId === subId) return f;
		}
		return undefined;
	};

	const folderByRootId = (rootId: string): FolderState | undefined => {
		for (const f of folders.values()) {
			if (f.rootId === rootId) return f;
		}
		return undefined;
	};

	/** Folders that should be subscribed right now (in use, or still within hold). */
	const wanted = (): FolderState[] =>
		[...folders.values()].filter((f) => f.listeners.size > 0 || f.releaseAt !== null);

	// -- subscription reconciliation ----------------------------------------

	/**
	 * Bring the server's subscription set in line with `folders`.
	 *
	 * Runs one at a time: navigation can change the set while a request is in
	 * flight, and two overlapping reconciliations would race to a set neither
	 * asked for. A change arriving mid-flight re-runs the loop instead.
	 */
	async function syncSubscriptions(): Promise<void> {
		if (stopped || !clientId) return;
		if (syncing) {
			syncAgain = true;
			return;
		}
		syncing = true;
		try {
			do {
				syncAgain = false;
				const currentClient = clientId;
				if (!currentClient) return;

				const desired = wanted();
				const toSubscribe = desired.filter((f) => f.subId === null);
				const toUnsubscribe = [...folders.values()].filter(
					(f) => f.subId !== null && f.listeners.size === 0 && f.releaseAt === null
				);
				if (toSubscribe.length === 0 && toUnsubscribe.length === 0) {
					// Nothing outstanding — but a stream carrying no folders at all is
					// still healthy, so report it rather than sitting on 'connecting'.
					if (status === 'connecting' && desired.length === 0) setStatus('subscribed');
					return;
				}

				// Register roots for anything new. Non-recursive: the explorer shows one
				// folder at a time, and a recursive root would pay descriptors for a
				// whole subtree nobody is looking at.
				for (const folder of toSubscribe) {
					if (folder.rootId) continue;
					try {
						const root = await transport.watchAddRoot(folder.path, false);
						folder.rootId = root.root_id;
					} catch {
						// Leave it unsubscribed; the next reconcile (or reconnect) retries.
						setStatus('error');
					}
				}

				const subscribe = toSubscribe
					.filter((f) => f.rootId)
					.map((f) => ({ rootId: f.rootId as string }));
				const unsubscribe = toUnsubscribe
					.map((f) => f.rootId)
					.filter((id): id is string => Boolean(id));
				if (subscribe.length === 0 && unsubscribe.length === 0) continue;

				try {
					const result = await transport.watchUpdateSubs({
						clientId: currentClient,
						subscribe,
						unsubscribe
					});
					for (const entry of result.subscribed) {
						const folder = folderByRootId(entry.root_id);
						if (folder) folder.subId = entry.sub_id;
					}
				} catch (e) {
					// The stream this client_id belongs to is gone: reconnecting mints a
					// new one, and the reconnect path re-subscribes everything.
					if (isClientGone(e)) {
						forceReconnect();
						return;
					}
					setStatus('error');
				}

				// Retire folders the server has now dropped.
				for (const folder of toUnsubscribe) {
					folder.subId = null;
					folder.rootId = null;
					folder.coalescer.cancel();
					if (folder.listeners.size === 0 && folder.releaseAt === null) {
						folders.delete(folder.path);
					}
				}
			} while (syncAgain);
		} finally {
			syncing = false;
		}
	}

	function isClientGone(e: unknown): boolean {
		const msg = e instanceof Error ? e.message : String(e);
		return msg.includes('client_not_found') || msg.includes('no live stream');
	}

	// -- hold / release ------------------------------------------------------

	function scheduleSweep(): void {
		if (stopped || sweepTimer) return;
		sweepTimer = setTimeout(() => {
			sweepTimer = null;
			const now = Date.now();
			let due = false;
			for (const folder of folders.values()) {
				if (folder.listeners.size === 0 && folder.releaseAt !== null && folder.releaseAt <= now) {
					folder.releaseAt = null;
					due = true;
				}
			}
			if (due) void syncSubscriptions();
			if ([...folders.values()].some((f) => f.releaseAt !== null)) scheduleSweep();
		}, holdMs);
	}

	// -- connection ----------------------------------------------------------

	function resetWatchdog(): void {
		if (watchdogTimer) clearTimeout(watchdogTimer);
		if (stopped) return;
		watchdogTimer = setTimeout(() => {
			if (stopped) return;
			console.warn('[monitor watch] watchdog timeout — forcing reconnect');
			abortController?.abort();
		}, watchdogMs);
	}

	function forceReconnect(): void {
		clientId = null;
		abortController?.abort();
	}

	function handleEvent(type: string, data: string): void {
		if (stopped) return;
		resetWatchdog();

		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(data) as Record<string, unknown>;
		} catch {
			return;
		}

		if (type === 'watch.hello') {
			clientId = typeof msg.client_id === 'string' ? msg.client_id : null;
			reconnectAttempt = 0;
			// Nothing is subscribed on a fresh stream — including after a reconnect,
			// where the server has forgotten the old client entirely.
			for (const folder of folders.values()) {
				folder.subId = null;
				folder.rootId = null;
			}
			void syncSubscriptions();
			return;
		}
		if (type === 'watch.subscribed') {
			const rootId = typeof msg.root_id === 'string' ? msg.root_id : null;
			const subId = typeof msg.sub_id === 'string' ? msg.sub_id : null;
			if (rootId && subId) {
				const folder = folderByRootId(rootId);
				if (folder) {
					folder.subId = subId;
					// Subscribing is the resync point: state may have changed while this
					// folder was unwatched, so re-read it rather than trusting the list.
					notify(folder);
				}
			}
			setStatus('subscribed');
			return;
		}
		if (type === 'watch.unsubscribed') {
			const subId = typeof msg.sub_id === 'string' ? msg.sub_id : null;
			const folder = subId ? folderBySubId(subId) : undefined;
			if (folder) {
				folder.subId = null;
				folder.rootId = null;
				// The server drops a subscription when its root is deleted. If anything
				// still wants the folder, re-register it from scratch.
				if (folder.listeners.size > 0 || folder.releaseAt !== null) {
					void syncSubscriptions();
				}
			}
			return;
		}
		if (type === 'watch.event_batch') {
			const subId = typeof msg.sub_id === 'string' ? msg.sub_id : null;
			const folder = subId ? folderBySubId(subId) : undefined;
			folder?.coalescer.fire();
			return;
		}
		if (type === 'watch.resync_required') {
			const subId = typeof msg.sub_id === 'string' ? msg.sub_id : null;
			const folder = subId ? folderBySubId(subId) : undefined;
			setStatus('resync');
			// Refetching current state *is* the resync; nothing is sent back.
			folder?.coalescer.fire();
			return;
		}
		if (type === 'watch.error') {
			setStatus('error');
		}
	}

	function scheduleReconnect(): void {
		if (stopped || reconnectTimer) return;
		reconnectAttempt += 1;
		if (reconnectAttempt > maxReconnectAttempts) {
			console.warn('[monitor watch] giving up after', maxReconnectAttempts, 'attempts');
			setStatus('error');
			return;
		}
		const base = Math.min(500 * 2 ** (reconnectAttempt - 1), maxReconnectDelayMs);
		const delay = base / 2 + Math.random() * (base / 2);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			void connect();
		}, delay);
	}

	async function connect(): Promise<void> {
		if (stopped || connecting) return;
		connecting = true;
		setStatus('connecting');
		clientId = null;

		const url = `${transport.baseUrl.replace(/\/$/, '')}/v1/watch/events`;
		const ac = new AbortController();
		abortController = ac;
		try {
			const res = await fetchFn(
				url,
				withLocalAddressSpace(url, {
					method: 'GET',
					headers: { accept: 'text/event-stream' },
					signal: ac.signal
				})
			);
			if (!res.ok || !res.body) {
				setStatus('error');
				connecting = false;
				scheduleReconnect();
				return;
			}
			resetWatchdog();

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			connecting = false;
			for (;;) {
				const { done, value } = await reader.read();
				if (done || stopped) break;
				buffer += decoder.decode(value, { stream: true });
				// Keep the trailing partial frame for the next chunk.
				const lastBreak = buffer.lastIndexOf('\n\n');
				if (lastBreak === -1) continue;
				const complete = buffer.slice(0, lastBreak + 2);
				buffer = buffer.slice(lastBreak + 2);
				for (const ev of parseSseChunk(complete)) {
					handleEvent(ev.event, ev.data);
				}
			}
		} catch {
			// Abort (navigation, watchdog, stop) and network failure land here alike.
		} finally {
			connecting = false;
			if (abortController === ac) abortController = null;
		}
		if (!stopped) {
			clientId = null;
			scheduleReconnect();
		}
	}

	// -- public API ----------------------------------------------------------

	return {
		watchFolder(path: string, listener: () => void) {
			let folder = folders.get(path);
			if (!folder) {
				const created: FolderState = {
					path,
					listeners: new Set(),
					rootId: null,
					subId: null,
					releaseAt: null,
					coalescer: createCoalescer(() => notify(created), { debounceMs, maxDebounceMs })
				};
				folder = created;
				folders.set(path, folder);
			}
			folder.listeners.add(listener);
			// Re-entering a folder inside its hold window: cancel the pending release.
			folder.releaseAt = null;

			if (!clientId && !connecting && !reconnectTimer) {
				void connect();
			} else {
				void syncSubscriptions();
			}

			let released = false;
			return () => {
				if (released) return;
				released = true;
				const current = folders.get(path);
				if (!current) return;
				current.listeners.delete(listener);
				if (current.listeners.size === 0) {
					current.coalescer.cancel();
					current.releaseAt = Date.now() + holdMs;
					scheduleSweep();
				}
			};
		},

		getStatus() {
			return status;
		},

		watchedPaths() {
			return wanted().map((f) => f.path);
		},

		stop() {
			stopped = true;
			// Release the roots this stream created BEFORE clearing the folder map,
			// which is the only place their ids are held.
			//
			// The daemon drops a root solely on an explicit DELETE — never when a
			// client disconnects or its SSE stream closes (roots are process-global
			// with no per-client ownership and no reaping). Without this, every
			// folder ever browsed leaks a root for the daemon's lifetime, and once
			// `max_roots` (default 16) is reached every new subscription fails with
			// a status of `error`, which presents as "live updates just stopped
			// working" long after the navigation that caused it.
			const rootIds = [...folders.values()]
				.map((f) => f.rootId)
				.filter((id): id is string => !!id);
			for (const folder of folders.values()) folder.coalescer.cancel();
			folders.clear();
			if (watchdogTimer) clearTimeout(watchdogTimer);
			if (reconnectTimer) clearTimeout(reconnectTimer);
			if (sweepTimer) clearTimeout(sweepTimer);
			watchdogTimer = null;
			reconnectTimer = null;
			sweepTimer = null;
			abortController?.abort();
			abortController = null;
			clientId = null;
			setStatus('closed');
			// Fire-and-forget: teardown must not block, and the transport already
			// swallows/warns per-root failures.
			for (const rootId of rootIds) void transport.watchRemoveRoot(rootId);
		}
	};
}
