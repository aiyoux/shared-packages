/**
 * The two session slots a document can have bound to it, and who is live.
 *
 * Both products grew this independently and identically — a peer slot for a
 * WebRTC invite, a tab slot for other tabs of this browser — and both resolved
 * it as `peer ?? tab`. That single `??` is why opening an invite silently
 * stopped cross-tab sync: one runtime, one session, tab session dropped.
 *
 * `active()` returns BOTH, so the host can build one relayed session over them
 * instead of choosing. The peer slot comes first only so a caller that still
 * wants a single answer gets the same one it used to.
 */

export type Slot = 'peer' | 'tab';

export type AttachSlot<A> = { slot: Slot; attach: A };

export type AttachRegistry<A> = {
	setPeer(next: A | null): void;
	setTab(next: A | null): void;
	/** Every live slot, peer first. Empty when nothing is attached. */
	active(): A[];
	/**
	 * The same, labelled with which slot each came from.
	 *
	 * The label is the registry's to give, not the caller's: stamping it onto
	 * the attach object at the call site would mean a fresh object on every
	 * publish, and a fresh object reads as a change — which rebuilds the
	 * session and mints a new clientId.
	 */
	activeSlots(): AttachSlot<A>[];
	/** Fires whenever `active()` would return something different. */
	subscribe(fn: () => void): () => void;
};

export function createAttachRegistry<A>(): AttachRegistry<A> {
	let peer: A | null = null;
	let tab: A | null = null;
	const listeners = new Set<() => void>();
	let last: A[] = [];

	function currentSlots(): AttachSlot<A>[] {
		const out: AttachSlot<A>[] = [];
		if (peer) out.push({ slot: 'peer', attach: peer });
		if (tab) out.push({ slot: 'tab', attach: tab });
		return out;
	}

	function current(): A[] {
		return currentSlots().map((s) => s.attach);
	}

	function notify(): void {
		const next = current();
		// Rebuilding a session mints a new clientId, and Documents piled up
		// "Guest" carets doing exactly that. Only tell anyone when the set of
		// live slots has really changed.
		if (next.length === last.length && next.every((a, i) => a === last[i])) return;
		last = next;
		for (const fn of [...listeners]) fn();
	}

	return {
		setPeer(next) {
			peer = next;
			notify();
		},
		setTab(next) {
			tab = next;
			notify();
		},
		active: current,
		activeSlots: currentSlots,
		subscribe(fn) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		}
	};
}
