/**
 * Svelte action: move `node` into `target` (a selector or element).
 * Waits for the host to appear so DualPaneExplorer can portal a settings
 * gear into the hub topbar that mounts in the same tick.
 */
export function portal(node: HTMLElement, target: string | HTMLElement | null | undefined) {
	let observer: MutationObserver | null = null;

	function clearObserver() {
		observer?.disconnect();
		observer = null;
	}

	function attach(next: string | HTMLElement | null | undefined) {
		clearObserver();
		if (!next || typeof document === 'undefined') return;
		const dest = typeof next === 'string' ? document.querySelector(next) : next;
		if (dest) {
			dest.appendChild(node);
			return;
		}
		if (typeof next !== 'string') return;
		observer = new MutationObserver(() => {
			const found = document.querySelector(next);
			if (!found) return;
			found.appendChild(node);
			clearObserver();
		});
		observer.observe(document.body, { childList: true, subtree: true });
	}

	attach(target);
	return {
		update(next: string | HTMLElement | null | undefined) {
			attach(next);
		},
		destroy() {
			clearObserver();
			node.remove();
		}
	};
}

/**
 * Full-screen modal overlays must not live inside a windowing leaf.
 *
 * The windowing shells isolate each window's body (`isolation: isolate` on
 * AppWindows' `.aw-body`, so in-pane toolbars cannot bleed through edit
 * overlays). A viewport-fixed modal rendered inside that body is trapped in
 * the stacking context: it centers on screen, but a sibling window paints
 * over it and steals its clicks. Portal the overlay to document.body so its
 * z-index competes at the root. Theme variables are root-scoped, so the move
 * costs nothing visually.
 */
export function portalModal(node: HTMLElement) {
	return portal(node, 'body');
}
