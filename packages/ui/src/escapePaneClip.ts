/**
 * Pane-header menus must not use `position: absolute` against the bar.
 *
 * App window leaves clip overflow (`overflow: hidden` on `.aw-leaf`). A menu
 * that is a descendant of that leaf and positioned `absolute` is painted
 * expanded-but-invisible — clicks toggle `aria-expanded` with nothing to see.
 * `position: fixed` against the trigger's viewport box escapes the clip.
 *
 * The node stays in its wrap in the DOM so outside-click handlers that test
 * `wrap.contains(target)` keep working. Every pane-header dropdown (FileChrome,
 * AnimFileChrome, sketcher InputModeControls, …) must use this action.
 */

export type EscapeAlign = 'start' | 'end';

export type EscapePaneClipOpts = {
	/** `end` pins the menu's right edge to the trigger's right edge. */
	align?: EscapeAlign;
};

type Rect = { left: number; right: number; bottom: number };
type Size = { width: number; height: number };
type Viewport = { width: number; height: number };

/** Pure placement — unit-tested; the action only reads the DOM and writes styles. */
export function escapedMenuBox(
	trigger: Rect,
	menu: Size,
	viewport: Viewport,
	opts: EscapePaneClipOpts = {}
): { left: number; top: number; maxHeight: number } {
	const pad = 8;
	const gap = 6;
	const maxHeight = Math.max(80, viewport.height - pad * 2);
	const height = Math.min(menu.height || 0, maxHeight);
	const width = menu.width || 170;
	const preferredLeft = opts.align === 'end' ? trigger.right - width : trigger.left;
	const left = Math.max(pad, Math.min(preferredLeft, viewport.width - width - pad));
	const preferredTop = trigger.bottom + gap;
	const top = Math.max(pad, Math.min(preferredTop, viewport.height - height - pad));
	return {
		left: Math.round(left),
		top: Math.round(top),
		maxHeight: Math.round(maxHeight)
	};
}

export function escapePaneClip(node: HTMLElement, opts: EscapePaneClipOpts = {}) {
	const place = () => {
		const trigger = node.previousElementSibling as HTMLElement | null;
		if (!trigger) return;
		const r = trigger.getBoundingClientRect();
		const box = escapedMenuBox(
			{ left: r.left, right: r.right, bottom: r.bottom },
			{ width: node.offsetWidth, height: node.offsetHeight || node.scrollHeight },
			{ width: window.innerWidth, height: window.innerHeight },
			opts
		);
		if ((node.scrollHeight || 0) > box.maxHeight) {
			node.style.maxHeight = `${box.maxHeight}px`;
			node.style.overflowY = 'auto';
		}
		node.style.position = 'fixed';
		node.style.marginTop = '0';
		node.style.right = 'auto';
		node.style.left = `${box.left}px`;
		node.style.top = `${box.top}px`;
	};
	place();
	const raf = requestAnimationFrame(place);
	window.addEventListener('resize', place);
	return {
		update(next: EscapePaneClipOpts) {
			opts = next ?? {};
			place();
		},
		destroy() {
			cancelAnimationFrame(raf);
			window.removeEventListener('resize', place);
		}
	};
}
