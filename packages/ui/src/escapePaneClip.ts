import { anchoredPopup, type PopupOptions } from '@shared-packages/design-system';
/**
 * Pane-header menus must not use `position: absolute` against the bar.
 *
 * App window leaves clip overflow (`overflow: hidden` on `.aw-leaf`). A menu
 * that is a descendant of that leaf and positioned `absolute` is painted
 * expanded-but-invisible — clicks toggle `aria-expanded` with nothing to see.
 * This compatibility action delegates to the shared native top-layer popup.
 *
 * The node stays in its wrap for theme inheritance and existing DOM contracts.
 * Supply onClose to share dismissal; omit it only when another registered
 * owner (for example a details flyout) already controls dismissal.
 */

export type EscapeAlign = 'start' | 'center' | 'end';

export type EscapePaneClipOpts = PopupOptions & {
	/** `end` pins the menu's right edge to the trigger's right edge. `center` puts the menu's midpoint on the trigger's midpoint. */
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
	const triggerWidth = trigger.right - trigger.left;
	const preferredLeft =
		opts.align === 'end'
			? trigger.right - width
			: opts.align === 'center'
				? trigger.left + triggerWidth / 2 - width / 2
				: trigger.left;
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
	const options = () => ({
		...opts,
		placement: opts.placement ?? (`bottom-${opts.align ?? 'start'}` as const),
		offset: 6,
		viewportMargin: 8,
		manageOverlay: Boolean(opts.onClose)
	});
	const action = anchoredPopup(node, options());
	return {
		update(next: EscapePaneClipOpts) {
			opts = next ?? {};
			action.update(options());
		},
		destroy: action.destroy
	};
}
