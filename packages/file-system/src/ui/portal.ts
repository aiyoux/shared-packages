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
