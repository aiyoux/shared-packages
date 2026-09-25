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
	/** The sender could not post this number; step past it. Carries no `msg`. */
	readonly skip?: true;
};

export type LiveBus<M> = {
	/** Ordered, gap-checked delivery. Use for anything that mutates the document. */
	broadcast(msg: M): void;
	/** Unordered, lossy-tolerant delivery. Use for transient previews. */
	broadcastImmediate(msg: M): void;
	onMessage(handler: (msg: M, sender: string) => void): () => void;
	/**
	 * A sender this bus has heard from is gone: its bus was destroyed or its
	 * tab died. Exact — every bus holds a Web Lock for its sender id, and this
	 * fires when that lock is granted to us. Everything learned from that
	 * sender (its presence, and anyone it relayed) is gone with it.
	 */
	onSenderGone(handler: (sender: string) => void): () => void;
	destroy(): void;
};

export type LiveBusOptions<M> = {
	/** Classifies a message as immediate (unsequenced). Default: none are. */
	isImmediate?: (msg: M) => boolean;
	/** Test seam — flush synchronously instead of on a frame. */
	flushSync?: boolean;
};

/**
 * Where a gap can come from, and why no timer waits on one.
 *
 * BroadcastChannel delivers one sender's posts in order to every live context,
 * and a batch is posted whole or not at all — a sender that dies mid-broadcast
 * loses a batch nobody numbered past. So a hole can only be a `postMessage`
 * that threw (a payload that will not structured-clone), and the sender knows
 * when that happens. It says so with `skip` envelopes, and receivers step past
 * the hole at once. This used to be a two-second deadline on the receiver,
 * which held every later message behind a hole for two seconds and then
 * guessed (M7).
 *
 * The cap below stays as a backstop for the one case a sender cannot report:
 * the storage transport, whose write can fail on quota.
 */
const MAX_OUT_OF_ORDER_BUFFER = 256;

type LockManagerLike = {
	request(
		name: string,
		options: { signal?: AbortSignal },
		cb: (lock: unknown) => Promise<void> | void
	): Promise<unknown>;
};

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
	let goneHandlers: Array<(sender: string) => void> = [];

	// --- sender locks ------------------------------------------------------
	const locks = (() => {
		const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
		return typeof nav?.locks?.request === 'function' ? nav.locks : null;
	})();
	const senderLock = (sender: string) => `${channelName}:sender:${sender}`;
	/**
	 * Nothing is posted until this bus holds its own sender lock: a receiver
	 * that heard from us first would queue on a free lock and read that as
	 * "gone".
	 */
	let lockHeld = !locks;
	let releaseOwnLock: (() => void) | null = null;
	if (locks) {
		void locks
			.request(senderLock(senderId), {}, () => {
				if (destroyed) return;
				lockHeld = true;
				if (pending.length && !cancelFlush) flush();
				return new Promise<void>((resolve) => {
					releaseOwnLock = resolve;
				});
			})
			.catch(() => {
				lockHeld = true;
			});
	}
	/** Senders we are watching, with the abort for our wait on their lock. */
	const watching = new Map<string, AbortController>();

	function watchSender(sender: string): void {
		if (!locks || watching.has(sender) || sender === senderId) return;
		const ctl = new AbortController();
		watching.set(sender, ctl);
		void locks
			.request(senderLock(sender), { signal: ctl.signal }, () => {
				if (destroyed || watching.get(sender) !== ctl) return;
				watching.delete(sender);
				expectedSeqs.delete(sender);
				buffers.delete(sender);
				for (const h of [...goneHandlers]) {
					try {
						h(sender);
					} catch {
						/* one bad subscriber must not stop the others */
					}
				}
			})
			.catch(() => {
				/* aborted on destroy */
			});
	}

	// --- outgoing ----------------------------------------------------------
	let outSeq = 1;
	let pending: LiveEnvelope<M>[] = [];
	let cancelFlush: (() => void) | null = null;

	function publish(batch: LiveEnvelope<M>[]): void {
		if (batch.length === 0) return;
		if (channel) {
			try {
				channel.postMessage(batch);
			} catch {
				// Could not post it (a payload that will not clone). Say which
				// numbers are gone so receivers step past them now, instead of
				// holding everything after them.
				const lost: LiveEnvelope<M>[] = batch
					.filter((e) => e.seq !== undefined)
					.map((e) => ({ sender: e.sender, seq: e.seq, skip: true, msg: undefined as M }));
				if (lost.length) {
					try {
						channel.postMessage(lost);
					} catch {
						/* channel closed */
					}
				}
			}
			return;
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
		if (destroyed || !lockHeld) return;
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

	function deliver(envelope: LiveEnvelope<M>): void {
		if (envelope.skip) return; // a number the sender could not post: nothing to hand on
		for (const h of [...handlers]) {
			try {
				h(envelope.msg, envelope.sender);
			} catch {
				/* one bad subscriber must not stop the others */
			}
		}
	}

	/**
	 * Step past a hole the sender never reported (the buffer cap): deliver
	 * everything buffered for this sender in order and resynchronise after it.
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
		if (buffer.size === 0) buffers.delete(sender);
		return next;
	}

	function processSequence(envelope: LiveEnvelope<M>): void {
		const { sender, seq } = envelope;

		// Immediate (or seq-less) messages skip ordering entirely.
		if (seq === undefined || (!envelope.skip && isImmediate(envelope.msg))) {
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
			if (buffer.size >= MAX_OUT_OF_ORDER_BUFFER) abandonGap(sender);
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
			watchSender(envelope.sender);
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
		onSenderGone(handler) {
			goneHandlers.push(handler);
			return () => {
				goneHandlers = goneHandlers.filter((h) => h !== handler);
			};
		},
		destroy() {
			// Post what was already sent before closing. Callers send a last
			// frame and destroy in the same tick — a tab's leave on close is
			// exactly that — and a frame-batched send would otherwise be
			// dropped here, silently, leaving the peer to time the tab out.
			cancelFlush?.();
			cancelFlush = null;
			flush();
			destroyed = true;
			handlers = [];
			goneHandlers = [];
			for (const ctl of watching.values()) ctl.abort();
			watching.clear();
			// Our sender lock going is the news, for anyone watching it.
			releaseOwnLock?.();
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
