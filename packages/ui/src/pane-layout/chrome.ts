/** Portal target id for an app to inject header items into a pane's chrome. */
export function paneChromeSlotId(leafId: string): string {
	return `pl-chrome-app-${leafId}`;
}

/**
 * Empty flex slot in the split tree where a keyed leaf is homed.
 * Closing/splitting reshapes the tree; leaf instances stay alive by moving
 * into the new slot instead of remounting.
 */
export function paneLeafSlotId(leafId: string): string {
	return `pl-leaf-slot-${leafId}`;
}

/**
 * The nearest element matching `selector` that belongs to `leaf` itself rather
 * than to a leaf nested inside it.
 *
 * Pane layouts are trees, so a leaf routinely contains further leaves. A plain
 * `leaf.querySelector` is a descendant search in document order and will
 * happily return a nested leaf's chrome, portalling an app's header items into
 * the wrong window.
 */
function ownDescendant(leaf: Element, selector: string): HTMLElement | null {
	for (const el of leaf.querySelectorAll(selector)) {
		if (el.closest('[data-testid="pl-leaf"]') === leaf) return el as HTMLElement;
	}
	return null;
}

/**
 * Find the nearest pane window header for app-injected chrome (File menu).
 * No-op host when not in a pane leaf — callers still render overlay chrome.
 */
export function findPaneWindowHeader(node: HTMLElement): {
	host: HTMLElement;
	chrome: HTMLElement;
} | null {
	const leaf = node.closest('[data-testid="pl-leaf"]');
	if (!leaf) return null;
	const chrome = ownDescendant(leaf, '[data-testid="pl-chrome"]');
	if (!chrome) return null;
	const slot = ownDescendant(leaf, '[data-testid="pl-chrome-app"]');
	return { host: slot ?? chrome, chrome };
}

/** Svelte action: portal into the pane header, or mark `in-overlay` standalone. */
export function portalToPaneWindowHeader(node: HTMLElement) {
	if (typeof document === 'undefined') return;
	const target = findPaneWindowHeader(node);
	if (!target) {
		node.classList.add('in-overlay');
		return;
	}
	const { host, chrome } = target;
	// The chrome belongs to the pane, not to us, so any style we put on it is
	// ours to take back off on destroy.
	let restorePosition = false;
	if (typeof getComputedStyle === 'function' && getComputedStyle(chrome).position === 'static') {
		chrome.style.position = 'relative';
		restorePosition = true;
	}
	host.appendChild(node);
	node.classList.add('in-chrome');
	return {
		destroy() {
			if (node.parentNode === host) host.removeChild(node);
			if (restorePosition) chrome.style.removeProperty('position');
		}
	};
}

/**
 * Move `node` into a pane's chrome slot, and keep it there as the leaf changes.
 *
 * Svelte `use:` action. No-op when the slot is missing (the app is not hosted
 * in a pane leaf), so callers do not need to branch on layout.
 */
export function portalToPaneChrome(node: HTMLElement, leafId: string) {
	if (!leafId || typeof document === 'undefined') return;
	const target = document.getElementById(paneChromeSlotId(leafId));
	if (!target) return;
	target.appendChild(node);
	return {
		update(nextId: string) {
			if (nextId === leafId) return;
			leafId = nextId;
			const next = document.getElementById(paneChromeSlotId(leafId));
			if (next) next.appendChild(node);
		},
		destroy() {
			if (node.parentNode === target) target.removeChild(node);
		}
	};
}
