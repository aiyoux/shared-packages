import { createSeqLog, type LogFrame } from './seqLog.js';
import type { CollabRole } from './docRuntime.js';

export type OrderedFrameRuntimeOpts<
	F extends LogFrame & { sequencer?: string }
> = {
	policy: 'ordered-frames';
	role: CollabRole;
	clientId: string;
	instance?: string;
	send(frame: F): void;
	applyFrame(frame: F): boolean;
	isSnapshot(frame: F): boolean;
	replaces?: (frame: F) => boolean;
	apply?: 'optimistic' | 'sequenced';
	/** The app's gesture already applied this submission. */
	localApplied?: boolean;
	onRepair(): void;
	onApplied?: (frame: F) => void;
	/**
	 * A replica now follows a different sequencer than it did: the last one's
	 * tab died, or froze and was taken over. Called after that sequencer's
	 * snapshot is applied. Frames sent to the old one and never numbered are
	 * the caller's to send again; not called for the first sequencer followed.
	 */
	onSequencerChange?: () => void;
};
export type OrderedFrameRuntime<F> = {
	readonly ready: boolean;
	submit(frame: F): void;
	/**
	 * Sequencer only: number and send a frame that describes the document as
	 * it already is (a snapshot answering a hello). It is not applied here —
	 * replacing a document with itself reads to the app as a new document.
	 */
	announce(frame: F): void;
	receive(frame: F): void;
	close(): void;
};

/** One order and repair loop for document frames, independent of their vocabulary. */
export function createFrameRuntime<F extends LogFrame & { sequencer?: string }>(
	opts: OrderedFrameRuntimeOpts<F>
): OrderedFrameRuntime<F> {
	const log = createSeqLog<F>({
		role: opts.role,
		clientId: opts.clientId,
		replaces: opts.replaces
	});
	// A rebuilt runtime starts a new sequence, even on the same client.
	const instance = opts.instance ?? globalThis.crypto.randomUUID();
	let ready = opts.role === 'sequencer';
	let closed = false;
	let following: string | undefined;
	const awaiting = new Set<string>();
	function apply(frame: F) {
		if (!opts.applyFrame(frame)) return false;
		if (opts.isSnapshot(frame)) ready = true;
		opts.onApplied?.(frame);
		return true;
	}
	return {
		get ready() {
			return ready;
		},
		submit(frame) {
			if (closed) return;
			const local = { ...frame, clientId: opts.clientId };
			if (
				!opts.localApplied &&
				(opts.role === 'sequencer' || opts.apply !== 'sequenced')
			) {
				if (!apply(local)) return;
			}
			if (opts.role === 'replica' && opts.apply === 'sequenced')
				awaiting.add(local.frameId);
			const stamped = log.stamp(local);
			opts.send(
				opts.role === 'sequencer'
					? { ...stamped, sequencer: instance }
					: stamped
			);
		},
		announce(frame) {
			if (closed || opts.role !== 'sequencer') return;
			const stamped = log.stamp({ ...frame, clientId: opts.clientId });
			opts.send({ ...stamped, sequencer: instance });
		},
		receive(frame) {
			if (closed) return;
			const snapshot = opts.isSnapshot(frame);
			let changed = false;
			if (opts.role === 'replica') {
				// Ignore submissions between replicas in sequenced mode; Creative's
				// optimistic mode detects an unnumbered frame as a bypass needing repair.
				if (frame.seq <= 0 && opts.apply === 'sequenced') return;
				if (frame.seq > 0 && frame.sequencer && frame.sequencer !== following) {
					if (!snapshot) {
						opts.onRepair();
						return;
					}
					log.reset(0);
					awaiting.clear();
					changed = following !== undefined;
					following = frame.sequencer;
				}
				// An echo is still part of the ordered stream. It must not skip edits
				// merely because its author is us.
				if (opts.apply === 'sequenced' && frame.clientId === opts.clientId) {
					if (frame.seq <= log.head) {
						awaiting.delete(frame.frameId);
						return;
					}
					if (!snapshot && frame.seq > log.head + 1) {
						opts.onRepair();
						return;
					}
				}
			}
			const pending =
				frame.clientId === opts.clientId && awaiting.delete(frame.frameId);
			const decision = log.receive(frame, apply, { rebase: snapshot });
			if (
				pending &&
				decision.action === 'dropped' &&
				decision.reason === 'echo'
			) {
				if (!apply(frame)) opts.onRepair();
				return;
			}
			if (decision.action === 'repair') opts.onRepair();
			if (decision.action === 'applied') {
				if (decision.broadcast)
					opts.send({ ...decision.broadcast, sequencer: instance });
				if (changed) opts.onSequencerChange?.();
			}
		},
		close() {
			closed = true;
			awaiting.clear();
		}
	};
}
