/**
 * Ordered same-browser message bus for one live document.
 *
 * Trimmed port of ~/Code/modular-app `module-sdk/src/sync/live.ts`, keeping the
 * parts that matter for local cross-tab work and dropping everything
 * server-backed (changefeed, offline queue, network health). See M7–M13 in
 * scratch-pad `docs/design/live-documents.md`.
 *
 * Two delivery classes, on purpose (M8):
 *  - **sequenced** — document commits. Gap-checked and delivered in order.
 *  - **immediate** — transient gesture previews. Unordered, lossy by design;
 *    a stale pose is simply superseded by the next one, so ordering machinery
 *    would only add latency.
 *
 * Outgoing messages are batched into one post per frame (M9), so a 60fps drag
 * stream costs one `postMessage` per frame rather than one per pose. Throttling
 * therefore belongs here, not in the apps.
 */

export type LiveEnvelope<M> = {
	readonly sender: string;
	/** Absent on immediate messages — they are deliberately unsequenced. */
	readonly seq?: number;
	readonly msg: M;
};

export type LiveBus<M> = {
	/** Ordered, gap-checked delivery. Use for anything that mutates the document. */
	broadcast(msg: M): void;
	/** Unordered, lossy-tolerant delivery. Use for transient previews. */
	broadcastImmediate(msg: M): void;
	onMessage(handler: (msg: M, sender: string) => void): () => void;
	destroy(): void;
};

export type LiveBusOptions<M> = {
	/** Classifies a message as immediate (unsequenced). Default: none are. */
	isImmediate?: (msg: M) => boolean;
	/** Test seam — flush synchronously instead of on a frame. */
	flushSync?: boolean;
	/** Override the gap-abandon deadline. Tests use a short one. */
	gapTimeoutMs?: number;
};

/**
 * How long a receiver waits for a missing sequence number before giving up and
 * delivering what it has buffered.
 *
 * Without this, a single undelivered envelope (a `postMessage` that threw, a
 * sender that died mid-broadcast) stalls EVERY later message from that sender
 * forever — the buffer only grows and nothing is delivered again until a
 * reload. Losing one message is survivable; silently withholding all later ones
 * looks exactly like "the other tab stopped syncing" (M7).
 */
const SEQ_GAP_TIMEOUT_MS = 2000;

/** Hard cap per sender; hitting it force-flushes immediately (see above). */
const MAX_OUT_OF_ORDER_BUFFER = 256;

function maybeUnref(ch: BroadcastChannel): void {
	// Node keeps the event loop alive for an open channel, which hangs tests.
	const unref = (ch as BroadcastChannel & { unref?: () => void }).unref;
	if (typeof unref === 'function') unref.call(ch);
}

function schedule(fn: () => void): () => void {
	if (typeof requestAnimationFrame === 'function') {
		const id = requestAnimationFrame(fn);
		return () => cancelAnimationFrame(id);
	}
	const id = setTimeout(fn, 0);
	return () => clearTimeout(id);
}

export function createLiveBus<M>(
	channelName: string,
	senderId: string,
	options?: LiveBusOptions<M>
): LiveBus<M> {
	const isImmediate = options?.isImmediate ?? (() => false);
	const gapTimeoutMs = options?.gapTimeoutMs ?? SEQ_GAP_TIMEOUT_MS;
	const storageKey = `${channelName}:storage`;
	let destroyed = false;

	let channel: BroadcastChannel | null = null;
	try {
		if (typeof BroadcastChannel !== 'undefined') {
			channel = new BroadcastChannel(channelName);
			maybeUnref(channel);
		}
	} catch {
		channel = null;
	}

	let handlers: Array<(msg: M, sender: string) => void> = [];

	// --- outgoing ----------------------------------------------------------
	let outSeq = 1;
	let pending: LiveEnvelope<M>[] = [];
	let cancelFlush: (() => void) | null = null;

	function publish(batch: LiveEnvelope<M>[]): void {
		if (batch.length === 0) return;
		if (channel) {
			try {
				channel.postMessage(batch);
				return;
			} catch {
				/* fall through to storage */
			}
		}
		if (typeof localStorage !== 'undefined') {
			try {
				// Key must change to fire `storage` in other tabs; the timestamp
				// makes two identical batches distinct.
				localStorage.setItem(storageKey, JSON.stringify({ at: Date.now(), batch }));
			} catch {
				/* quota or private mode — the message is simply lost */
			}
		}
	}

	function flush(): void {
		cancelFlush = null;
		if (destroyed) return;
		const batch = pending;
		pending = [];
		publish(batch);
	}

	function enqueue(envelope: LiveEnvelope<M>): void {
		if (destroyed) return;
		pending.push(envelope);
		if (options?.flushSync) {
			flush();
			return;
		}
		if (!cancelFlush) cancelFlush = schedule(flush);
	}

	// --- incoming ----------------------------------------------------------
	const expectedSeqs = new Map<string, number>();
	const buffers = new Map<string, Map<number, LiveEnvelope<M>>>();
	const gapTimers = new Map<string, ReturnType<typeof setTimeout>>();

	function deliver(envelope: LiveEnvelope<M>): void {
		for (const h of [...handlers]) {
			try {
				h(envelope.msg, envelope.sender);
			} catch {
				/* one bad subscriber must not stop the others */
			}
		}
	}

	function clearGapTimer(sender: string): void {
		const t = gapTimers.get(sender);
		if (t !== undefined) {
			clearTimeout(t);
			gapTimers.delete(sender);
		}
	}

	function armGapTimer(sender: string): void {
		if (gapTimers.has(sender)) return;
		const t = setTimeout(() => {
			gapTimers.delete(sender);
			abandonGap(sender);
		}, gapTimeoutMs);
		(t as { unref?: () => void }).unref?.();
		gapTimers.set(sender, t);
	}

	/**
	 * Give up on a missing sequence number: deliver everything buffered for
	 * this sender in ascending order and resynchronise past the hole.
	 *
	 * Degraded-but-live beats correct-but-wedged (M7).
	 */
	function abandonGap(sender: string): void {
		const buffer = buffers.get(sender);
		buffers.delete(sender);
		if (!buffer || buffer.size === 0) return;
		const seqs = [...buffer.keys()].sort((a, b) => a - b);
		let next = expectedSeqs.get(sender) ?? seqs[0];
		for (const seq of seqs) {
			deliver(buffer.get(seq)!);
			next = seq + 1;
		}
		expectedSeqs.set(sender, next);
	}

	/** Drain any buffered envelopes that are now contiguous. */
	function flushBuffered(sender: string, from: number): number {
		const buffer = buffers.get(sender);
		if (!buffer) return from;
		let next = from;
		while (buffer.has(next)) {
			deliver(buffer.get(next)!);
			buffer.delete(next);
			next += 1;
		}
		if (buffer.size === 0) {
			buffers.delete(sender);
			clearGapTimer(sender);
		}
		return next;
	}

	function processSequence(envelope: LiveEnvelope<M>): void {
		const { sender, seq } = envelope;

		// Immediate (or seq-less) messages skip ordering entirely.
		if (seq === undefined || isImmediate(envelope.msg)) {
			deliver(envelope);
			return;
		}

		const expected = expectedSeqs.get(sender);

		if (expected === undefined) {
			// First mutation heard from this sender — adopt its starting point.
			expectedSeqs.set(sender, seq + 1);
			deliver(envelope);
			return;
		}

		if (seq < expected) return; // stale or duplicate

		if (seq > expected) {
			let buffer = buffers.get(sender);
			if (!buffer) {
				buffer = new Map();
				buffers.set(sender, buffer);
			}
			buffer.set(seq, envelope);
			if (buffer.size >= MAX_OUT_OF_ORDER_BUFFER) {
				clearGapTimer(sender);
				abandonGap(sender);
			} else {
				armGapTimer(sender);
			}
			return;
		}

		deliver(envelope);
		expectedSeqs.set(sender, flushBuffered(sender, expected + 1));
	}

	function receiveBatch(batch: unknown): void {
		if (destroyed || !Array.isArray(batch)) return;
		for (const raw of batch) {
			const envelope = raw as LiveEnvelope<M>;
			if (!envelope || typeof envelope !== 'object') continue;
			// Self-filter at the transport. Op semantics stay idempotent so no
			// "did I originate this?" bookkeeping is needed above (M11).
			if (envelope.sender === senderId) continue;
			processSequence(envelope);
		}
	}

	function onChannelMessage(event: MessageEvent): void {
		receiveBatch(event.data);
	}

	function onStorage(event: StorageEvent): void {
		if (event.key !== storageKey || !event.newValue) return;
		try {
			receiveBatch((JSON.parse(event.newValue) as { batch?: unknown }).batch);
		} catch {
			/* malformed payload from an older build */
		}
	}

	channel?.addEventListener('message', onChannelMessage as EventListener);

	// Only listen on the storage transport when it IS the transport. With a
	// BroadcastChannel present `publish` never writes the key, and listening
	// anyway would re-deliver whatever an older tab wrote (M12).
	const useStorage = !channel && typeof window !== 'undefined';
	if (useStorage) window.addEventListener('storage', onStorage);

	return {
		broadcast(msg: M) {
			enqueue({ sender: senderId, seq: outSeq++, msg });
		},
		broadcastImmediate(msg: M) {
			enqueue({ sender: senderId, msg });
		},
		onMessage(handler) {
			handlers.push(handler);
			return () => {
				handlers = handlers.filter((h) => h !== handler);
			};
		},
		destroy() {
			destroyed = true;
			cancelFlush?.();
			cancelFlush = null;
			pending = [];
			handlers = [];
			for (const sender of [...gapTimers.keys()]) clearGapTimer(sender);
			buffers.clear();
			expectedSeqs.clear();
			try {
				channel?.removeEventListener('message', onChannelMessage as EventListener);
				channel?.close();
			} catch {
				/* already closed */
			}
			if (useStorage) window.removeEventListener('storage', onStorage);
		}
	};
}
