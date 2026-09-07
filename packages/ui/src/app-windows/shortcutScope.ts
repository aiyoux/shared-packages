/**
 * Which AppWindows mount should handle Shift+W / Shift+S.
 *
 * Every mount used to listen on `window`, so a shortcut in a secondary hub
 * pane toggled edit/slice on the first Files/Sketch/KB instance as well.
 */
export function appWindowsOwnsShortcut(
	host: HTMLElement | null,
	target: EventTarget | null
): boolean {
	if (!host) return false;
	const nested = Boolean(host.parentElement?.closest('.aw-host'));
	const el = elementFromTarget(target);
	if (el) {
		const inner = el.closest('.aw-host');
		if (inner) return inner === host;
		const leaf = host.closest('[data-testid="pl-leaf"]');
		if (!leaf) return !nested;
		if (!leaf.contains(el)) return false;
		return !nested;
	}
	if (nested) return false;
	const leaf = host.closest('[data-testid="pl-leaf"]');
	if (!leaf) return true;
	return leaf.getAttribute('data-pl-focused') === 'true';
}

function elementFromTarget(target: EventTarget | null): Element | null {
	if (!target || typeof target !== 'object') return null;
	if (typeof (target as Element).closest === 'function') return target as Element;
	const parent = (target as Node).parentElement;
	if (parent && typeof parent.closest === 'function') return parent;
	return null;
}
