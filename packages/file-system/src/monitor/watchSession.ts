/**
 * Browser-side watch WebSocket for monitor live list refresh.
 *
 * REST (add root) and WebSocket both hit the profile base URL directly.
 */

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
	/** WebSocket constructor (tests) */
	WebSocketImpl?: typeof WebSocket;
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

function toWsUrl(httpBase: string): string {
	const u = new URL(httpBase.endsWith('/') ? httpBase : httpBase + '/');
	u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
	u.pathname = '/v1/watch/stream';
	u.search = '';
	u.hash = '';
	return u.toString();
}

/**
 * Ensure root is watched, open WS, subscribe, fan out debounced onChange.
 */
export function startWatchSession(opts: WatchSessionOptions): WatchSession {
	const debounceMs = opts.debounceMs ?? 150;
	const WS = opts.WebSocketImpl ?? WebSocket;
	let status: WatchSessionStatus = 'connecting';
	let stopped = false;
	let ws: WebSocket | null = null;
	let subId: string | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let pingTimer: ReturnType<typeof setInterval> | null = null;
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
		if (pingTimer) {
			clearInterval(pingTimer);
			pingTimer = null;
		}
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
	};

	const send = (msg: Record<string, unknown>) => {
		if (ws && ws.readyState === WS.OPEN) {
			ws.send(JSON.stringify(msg));
		}
	};

	const connect = async () => {
		if (stopped) return;
		setStatus('connecting');
		let root: WatchedRoot;
		try {
			root = await opts.ensureRoot(opts.rootPath, true);
		} catch (e) {
			setStatus('error');
			// Still allow browse without live updates
			console.warn('[monitor watch] ensureRoot failed', e);
			return;
		}
		if (stopped) return;

		const url = toWsUrl(opts.baseUrl);
		try {
			ws = new WS(url);
		} catch (e) {
			setStatus('error');
			console.warn('[monitor watch] WebSocket open failed', e);
			scheduleReconnect();
			return;
		}

		ws.onopen = () => {
			reconnectAttempt = 0;
			// Wait for hello before subscribe
		};

		ws.onmessage = (ev) => {
			if (stopped) return;
			let data: Record<string, unknown>;
			try {
				data = JSON.parse(String(ev.data)) as Record<string, unknown>;
			} catch {
				return;
			}
			const type = data.type as string | undefined;
			if (type === 'watch.hello') {
				send({
					type: 'watch.subscribe',
					root_id: root.root_id
				});
				return;
			}
			if (type === 'watch.subscribed') {
				subId = typeof data.sub_id === 'string' ? data.sub_id : null;
				setStatus('subscribed');
				// Initial resync-style refresh once subscribed
				fireChange();
				if (!pingTimer) {
					pingTimer = setInterval(() => send({ type: 'watch.ping' }), 20_000);
				}
				return;
			}
			if (type === 'watch.event_batch') {
				const seq = typeof data.seq === 'number' ? data.seq : undefined;
				if (subId && seq != null) {
					send({ type: 'watch.ack', sub_id: subId, seq });
				}
				fireChange();
				return;
			}
			if (type === 'watch.resync_required') {
				setStatus('resync');
				if (subId) send({ type: 'watch.resync', sub_id: subId });
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
			}
		};

		ws.onerror = () => {
			/* onclose handles reconnect */
		};

		ws.onclose = () => {
			ws = null;
			subId = null;
			if (pingTimer) {
				clearInterval(pingTimer);
				pingTimer = null;
			}
			if (!stopped) {
				setStatus('closed');
				scheduleReconnect();
			}
		};
	};

	const scheduleReconnect = () => {
		if (stopped) return;
		const delay = Math.min(10_000, 500 * 2 ** reconnectAttempt);
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
			try {
				ws?.close();
			} catch {
				/* ignore */
			}
			ws = null;
		},
		getStatus() {
			return status;
		}
	};
}
