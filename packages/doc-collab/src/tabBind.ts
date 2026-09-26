/**
 * Tab close and the two watches that belong to one open document.
 *
 * Svelte `onDestroy` does not run when a tab closes. `pagehide` does, and it
 * is early enough that a channel can still flush a leave. A bfcache
 * `persisted` hide is not a close: the page can return with its session
 * intact, and tearing it down here would leave it mute.
 *
 * `pagehide` does not fire for a crashed or killed tab. The bus's
 * sender-gone signal covers that (the browser releases the dead tab's lock);
 * this is only the common case.
 *
 * Who wins each lock stays in the host's watcher. This starts them together
 * and stops them together — it does not pick a winner.
 */

/**
 * Invoke `close` on `pagehide`, except when the page is being frozen into
 * the back-forward cache (`event.persisted`).
 */
export function installCollabUnload(close: () => void): () => void {
	const target = globalThis.window;
	if (typeof target === 'undefined') return () => {};
	const onHide = (event: Event) => {
		if ('persisted' in event && (event as PageTransitionEvent).persisted) return;
		close();
	};
	target.addEventListener('pagehide', onHide);
	return () => target.removeEventListener('pagehide', onHide);
}

/**
 * Start sequencing-role watch, persist-owner watch, and tab-close unload.
 * The returned function removes the pagehide listener and stops both watches.
 */
export function bindTabCollab(opts: {
	startSequencer: (onRole: (role: 'sequencer' | 'replica') => void) => () => void;
	startPersist: (onOwner: (isOwner: boolean) => void) => () => void;
	close: () => void;
}): () => void {
	const stopSequencer = opts.startSequencer(() => {});
	const stopPersist = opts.startPersist(() => {});
	const stopUnload = installCollabUnload(opts.close);
	return () => {
		stopUnload();
		stopSequencer();
		stopPersist();
	};
}
