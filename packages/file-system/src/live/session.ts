/**
 * One live document, shared across every tab of this browser.
 *
 * The leader holds the authoritative copy and assigns sequence numbers;
 * followers hold replicas and forward intents. Followers deliberately do NOT
 * apply optimistically — they wait for the leader's echo. A BroadcastChannel
 * round trip inside one browser is sub-millisecond, so the wait is
 * imperceptible, and it keeps us out of the optimistic-apply-then-reconcile
 * territory that requires operation transformation (which `kb-model` explicitly
 * forbids: "Never transformOp, never invert-local"). See L1/L4 in scratch-pad
 * `docs/design/live-documents.md`.
 *
 * `reduce` is the only app-supplied part — the DRY seam. Everything else here
 * is document-shape agnostic.
 *
 * Ordering note: `seq` is globally monotonic across leadership changes, because
 * a promoted tab continues from the last seq it applied. `leaderSessionId` is a
 * *local* epoch used only to fence this tab's own in-flight intents (M2); it is
 * never compared across tabs.
 */

import { createLeaderElection, type LeaderElection } from './leader.js';
import { createLiveBus, type LiveBus, type LiveBusOptions } from './bus.js';
import { liveDocNames } from './names.js';

export type LiveRole = 'leader' | 'follower';

export type LiveDocMeta = {
	readonly seq: number;
	readonly role: LiveRole;
	/** What moved the document: our own commit, a peer's, or a snapshot adopt. */
	readonly reason: 'local' | 'remote' | 'snapshot' | 'replace';
};

export type LiveSavedInfo = {
	readonly seq: number;
	readonly generation: number;
	readonly fingerprint?: string;
};

type Frame<Doc, Op> =
	| { t: 'hello'; from: string }
	| { t: 'snapshot'; leaderId: string; seq: number; doc: Doc }
	| { t: 'intent'; from: string; id: string; op: Op }
	| { t: 'nack'; to: string; id: string; error: string }
	| { t: 'commit'; leaderId: string; seq: number; op: Op; fromIntent?: string }
	| { t: 'transient'; payload: unknown }
	| { t: 'saved'; leaderId: string; seq: number; generation: number; fingerprint?: string }
	| { t: 'resync'; from: string };

export type LiveSessionOptions<Doc, Op> = {
	nodeId: string;
	/** The document as this tab currently knows it (already loaded from the VFS). */
	initial: Doc;
	/** Pure and idempotent. Both the local and remote paths go through it. */
	reduce: (doc: Doc, op: Op) => Doc;
	onDoc?: (doc: Doc, meta: LiveDocMeta) => void;
	onRole?: (role: LiveRole) => void;
	onTransient?: (payload: unknown, sender: string) => void;
	onSaved?: (info: LiveSavedInfo) => void;
	/** How long a follower waits for the leader to act on an intent. */
	intentTimeoutMs?: number;
	/** Distinct id per session instance. Defaults to the tab id. */
	senderId?: string;
	busOptions?: Pick<LiveBusOptions<unknown>, 'flushSync' | 'gapTimeoutMs'>;
};

export type LiveSession<Doc, Op> = {
	readonly role: LiveRole;
	readonly doc: Doc;
	readonly seq: number;
	readonly senderId: string;
	/** Leader applies and broadcasts; follower forwards and awaits the echo. */
	commit(op: Op): Promise<void>;
	/** Unordered, lossy-tolerant preview (drag poses). Never persisted. */
	sendTransient(payload: unknown): void;
	/** Leader announces a save so followers adopt the new CAS generation. */
	announceSaved(generation: number, fingerprint?: string): void;
	/** Adopt a document from outside the op stream (promotion reload, revert). */
	replaceDoc(doc: Doc): void;
	destroy(): void;
};

const DEFAULT_INTENT_TIMEOUT_MS = 5000;

function newId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	return typeof c?.randomUUID === 'function' ? c.randomUUID() : `i-${Math.random().toString(36).slice(2)}`;
}

export function createLiveSession<Doc, Op>(
	options: LiveSessionOptions<Doc, Op>
): LiveSession<Doc, Op> {
	const { nodeId, reduce } = options;
	const { channelName } = liveDocNames(nodeId);
	const intentTimeoutMs = options.intentTimeoutMs ?? DEFAULT_INTENT_TIMEOUT_MS;

	const election: LeaderElection = createLeaderElection(nodeId);
	const senderId = options.senderId ?? election.tabId;

	let doc = options.initial;
	let seq = 0;
	let role: LiveRole = election.isLeader ? 'leader' : 'follower';
	let destroyed = false;

	const bus: LiveBus<Frame<Doc, Op>> = createLiveBus<Frame<Doc, Op>>(channelName, senderId, {
		// Transient previews must not be held behind a commit gap (M8).
		isImmediate: (m) => m.t === 'transient' || m.t === 'hello' || m.t === 'resync',
		...options.busOptions
	});

	type Pending = {
		resolve: () => void;
		reject: (err: Error) => void;
		timer: ReturnType<typeof setTimeout>;
		/** Local epoch this intent was issued under — see the header note (M2). */
		epoch: number;
	};
	const pending = new Map<string, Pending>();

	function settle(id: string, err?: Error): void {
		const p = pending.get(id);
		if (!p) return;
		pending.delete(id);
		clearTimeout(p.timer);
		if (err) p.reject(err);
		else p.resolve();
	}

	function rejectAllPending(reason: string): void {
		for (const id of [...pending.keys()]) settle(id, new Error(reason));
	}

	function emitDoc(reason: LiveDocMeta['reason']): void {
		options.onDoc?.(doc, { seq, role, reason });
	}

	/**
	 * Apply an op to the local replica.
	 *
	 * Returns false without advancing `seq` if the reducer threw: marking
	 * ourselves converged over a failed apply would leave the replica quietly
	 * stale until the next disconnect (M14). The caller asks for a snapshot
	 * instead.
	 */
	function applyLocal(op: Op, nextSeq: number, reason: LiveDocMeta['reason']): boolean {
		try {
			doc = reduce(doc, op);
		} catch {
			return false;
		}
		seq = nextSeq;
		emitDoc(reason);
		return true;
	}

	function requestResync(): void {
		bus.broadcast({ t: 'resync', from: senderId });
	}

	function onFrame(frame: Frame<Doc, Op>): void {
		if (destroyed) return;

		switch (frame.t) {
			case 'hello':
			case 'resync': {
				// Only the leader can answer, and only it has the truth.
				if (role !== 'leader') return;
				bus.broadcast({ t: 'snapshot', leaderId: senderId, seq, doc });
				return;
			}

			case 'snapshot': {
				if (role === 'leader') return; // we are the authority; ignore
				// A snapshot is authoritative for the whole document, so adopting
				// wholesale is safe here (contrast M16, which concerns partial
				// snapshots).
				doc = frame.doc;
				seq = frame.seq;
				emitDoc('snapshot');
				return;
			}

			case 'intent': {
				if (role !== 'leader') return;
				const nextSeq = seq + 1;
				let next: Doc;
				try {
					next = reduce(doc, frame.op);
				} catch (err) {
					bus.broadcast({
						t: 'nack',
						to: frame.from,
						id: frame.id,
						error: err instanceof Error && err.message ? err.message : 'reduce failed'
					});
					return;
				}
				doc = next;
				seq = nextSeq;
				emitDoc('remote');
				bus.broadcast({
					t: 'commit',
					leaderId: senderId,
					seq: nextSeq,
					op: frame.op,
					fromIntent: frame.id
				});
				return;
			}

			case 'nack': {
				if (frame.to !== senderId) return;
				settle(frame.id, new Error(frame.error));
				return;
			}

			case 'commit': {
				if (role === 'leader') return; // our own authority, already applied
				if (frame.seq <= seq) return; // stale or duplicate
				if (frame.seq !== seq + 1) {
					// A hole: the bus already gave up waiting for the missing
					// envelope, so pull the truth rather than guess.
					requestResync();
					return;
				}
				const ok = applyLocal(frame.op, frame.seq, 'remote');
				if (!ok) {
					requestResync();
					return;
				}
				if (frame.fromIntent) settle(frame.fromIntent);
				return;
			}

			case 'transient': {
				options.onTransient?.(frame.payload, senderId);
				return;
			}

			case 'saved': {
				options.onSaved?.({
					seq: frame.seq,
					generation: frame.generation,
					fingerprint: frame.fingerprint
				});
				return;
			}
		}
	}

	const offBus = bus.onMessage((frame, sender) => {
		// `transient` needs the real sender for per-tab presence colouring.
		if (frame.t === 'transient') {
			options.onTransient?.(frame.payload, sender);
			return;
		}
		onFrame(frame);
	});

	const offLeader = election.onChange(() => {
		if (destroyed) return;
		const nextRole: LiveRole = election.isLeader ? 'leader' : 'follower';
		if (nextRole === role) return;
		role = nextRole;
		// Any intent issued under the previous epoch is void — the tab it was
		// addressed to is no longer authoritative. Reject so the caller retries
		// against the new leader (M2).
		rejectAllPending('leadership changed');
		options.onRole?.(role);
		if (role === 'follower') {
			// Someone else took over (a yield); pull their truth.
			bus.broadcast({ t: 'hello', from: senderId });
		}
	});

	// Ask whoever holds the document to introduce themselves. Harmless when we
	// turn out to be the leader — nobody answers.
	bus.broadcast({ t: 'hello', from: senderId });

	return {
		get role() {
			return role;
		},
		get doc() {
			return doc;
		},
		get seq() {
			return seq;
		},
		get senderId() {
			return senderId;
		},

		commit(op: Op): Promise<void> {
			if (destroyed) return Promise.reject(new Error('session destroyed'));

			if (role === 'leader') {
				// The leader IS the authority — applying here is not optimistic.
				const nextSeq = seq + 1;
				let next: Doc;
				try {
					next = reduce(doc, op);
				} catch (err) {
					return Promise.reject(err instanceof Error ? err : new Error('reduce failed'));
				}
				doc = next;
				seq = nextSeq;
				emitDoc('local');
				bus.broadcast({ t: 'commit', leaderId: senderId, seq: nextSeq, op });
				return Promise.resolve();
			}

			const id = newId();
			const epoch = election.leaderSessionId;
			return new Promise<void>((resolve, reject) => {
				// Deliberately NOT unref'd: this deadline is what the caller is
				// awaiting, so it must keep the loop alive to fire at all.
				const timer = setTimeout(() => {
					settle(id, new Error('intent timed out'));
				}, intentTimeoutMs);
				pending.set(id, { resolve, reject, timer, epoch });
				bus.broadcast({ t: 'intent', from: senderId, id, op });
			});
		},

		sendTransient(payload: unknown) {
			if (destroyed) return;
			bus.broadcastImmediate({ t: 'transient', payload });
		},

		announceSaved(generation: number, fingerprint?: string) {
			if (destroyed || role !== 'leader') return;
			// Followers MUST adopt the new generation or their own next save
			// fails CAS and raises a spurious conflict.
			bus.broadcast({ t: 'saved', leaderId: senderId, seq, generation, fingerprint });
			options.onSaved?.({ seq, generation, fingerprint });
		},

		replaceDoc(next: Doc) {
			doc = next;
			emitDoc('replace');
			if (role === 'leader') bus.broadcast({ t: 'snapshot', leaderId: senderId, seq, doc });
		},

		destroy() {
			destroyed = true;
			rejectAllPending('session destroyed');
			offBus();
			offLeader();
			bus.destroy();
			election.destroy();
		}
	};
}
