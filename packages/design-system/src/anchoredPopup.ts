import { overlay, type OverlayOptions } from './overlay.ts';
export type Placement =
	| 'top-start'
	| 'top-center'
	| 'top-end'
	| 'bottom-start'
	| 'bottom-center'
	| 'bottom-end'
	| 'left'
	| 'right';
export interface PopupOptions extends OverlayOptions {
	/** Context menus can anchor to a pointer rather than an element. */
	anchorRect?: () => DOMRect | undefined;
	anchor?: () => HTMLElement | null | undefined;
	placement?: Placement;
	offset?: number;
	viewportMargin?: number;
	mobileMode?: 'popover' | 'center';
	mobileBreakpoint?: number;
	/** Position only, for compatibility actions whose callers own open state. */
	manageOverlay?: boolean;
	portal?: boolean;
}
export function popupPosition(rect: DOMRect, panelRect: DOMRect, options: PopupOptions = {}) {
	const {
		placement = 'bottom-start',
		offset = 8,
		viewportMargin = 12,
		mobileMode = 'popover',
		mobileBreakpoint = 720
	} = options;
	const margin = viewportMargin;
	const viewportWidth = window.innerWidth;
	const viewportHeight = window.innerHeight;

	if (mobileMode === 'center' && viewportWidth <= mobileBreakpoint) {
		return {
			top: Math.max(margin, (viewportHeight - panelRect.height) / 2),
			left: Math.max(margin, (viewportWidth - panelRect.width) / 2),
			visibility: 'visible' as const
		};
	}

	const placements: Placement[] = placement.startsWith('bottom')
		? [
				placement,
				placement === 'bottom-start'
					? 'top-start'
					: placement === 'bottom-end'
						? 'top-end'
						: 'top-center',
				'right',
				'left'
			]
		: placement.startsWith('top')
			? [
					placement,
					placement === 'top-start'
						? 'bottom-start'
						: placement === 'top-end'
							? 'bottom-end'
							: 'bottom-center',
					'right',
					'left'
				]
			: placement === 'left'
				? ['left', 'right', 'bottom-start', 'top-start']
				: ['right', 'left', 'bottom-end', 'top-end'];

	for (const candidate of placements) {
		let top = 0;
		let left = 0;

		if (candidate === 'bottom-start') {
			top = rect.bottom + offset;
			left = rect.left;
		} else if (candidate === 'bottom-center') {
			top = rect.bottom + offset;
			left = rect.left + rect.width / 2 - panelRect.width / 2;
		} else if (candidate === 'bottom-end') {
			top = rect.bottom + offset;
			left = rect.right - panelRect.width;
		} else if (candidate === 'top-start') {
			top = rect.top - panelRect.height - offset;
			left = rect.left;
		} else if (candidate === 'top-center') {
			top = rect.top - panelRect.height - offset;
			left = rect.left + rect.width / 2 - panelRect.width / 2;
		} else if (candidate === 'top-end') {
			top = rect.top - panelRect.height - offset;
			left = rect.right - panelRect.width;
		} else if (candidate === 'left') {
			top = rect.top + rect.height / 2 - panelRect.height / 2;
			left = rect.left - panelRect.width - offset;
		} else {
			top = rect.top + rect.height / 2 - panelRect.height / 2;
			left = rect.right + offset;
		}

		const fitsVertically = top >= margin && top + panelRect.height <= viewportHeight - margin;
		const fitsHorizontally = left >= margin && left + panelRect.width <= viewportWidth - margin;

		if (fitsVertically && fitsHorizontally) {
			return {
				top,
				left,
				visibility: 'visible' as const
			};
		}
	}

	let fallbackTop = rect.bottom + offset;
	let fallbackLeft = rect.left;

	if (placement === 'bottom-center' || placement === 'top-center') {
		fallbackLeft = rect.left + rect.width / 2 - panelRect.width / 2;
	}
	if (placement === 'bottom-end' || placement === 'top-end') {
		fallbackLeft = rect.right - panelRect.width;
	}
	if (placement === 'top-start' || placement === 'top-center' || placement === 'top-end') {
		fallbackTop = rect.top - panelRect.height - offset;
	}
	if (placement === 'left') {
		fallbackTop = rect.top + rect.height / 2 - panelRect.height / 2;
		fallbackLeft = rect.left - panelRect.width - offset;
	}
	if (placement === 'right') {
		fallbackTop = rect.top + rect.height / 2 - panelRect.height / 2;
		fallbackLeft = rect.right + offset;
	}

	return {
		top: Math.max(margin, Math.min(fallbackTop, viewportHeight - panelRect.height - margin)),
		left: Math.max(margin, Math.min(fallbackLeft, viewportWidth - panelRect.width - margin)),
		visibility: 'visible' as const
	};
}

/** Retains DOM/theme inheritance while the browser top layer escapes every clip. */
export function anchoredPopup(node: HTMLElement, options: PopupOptions = {}) {
	const savedStyle = node.getAttribute('style');
	const fallbackAnchor = options.anchorRect
		? null
		: (node.previousElementSibling as HTMLElement | null);
	const savedPopover = node.getAttribute('popover');
	const appearance = getComputedStyle(node);
	const maxHeight = Number.parseFloat(appearance.maxHeight),
		maxWidth = Number.parseFloat(appearance.maxWidth);
	const overflowY = appearance.overflowY;
	const background = appearance.backgroundColor,
		border = appearance.border,
		padding = appearance.padding,
		color = appearance.color;
	// UA sheets keep `[popover]:not(:popover-open)` at display:none, and only
	// the API's showPopover() flips it open. Where the API is absent (jsdom,
	// older engines) nothing flips it, so the attribute itself would hide the
	// menu for good — set it only when it can be shown.
	const supportsPopover = typeof node.showPopover === 'function';
	if (supportsPopover) node.setAttribute('popover', 'manual');
	node.style.backgroundColor = background;
	node.style.border = border;
	node.style.padding = padding;
	node.style.color = color;
	node.style.position = 'fixed';
	node.style.inset = 'auto';
	node.style.margin = '0';
	node.style.visibility = 'hidden';
	const registration =
		options.manageOverlay === false
			? undefined
			: overlay(node, {
					kind: 'popover',
					focusOnOpen: false,
					trapFocus: false,
					...options,
					portal: false,
					anchor: () => options.anchor?.() ?? fallbackAnchor
				});
	if (options.portal) document.body.appendChild(node);
	if (supportsPopover) node.showPopover();
	let frame = 0;
	let signature = '';
	const position = () => {
		const anchor = options.anchor?.() ?? fallbackAnchor;
		const rect =
			options.anchorRect?.() ?? (anchor?.isConnected ? anchor.getBoundingClientRect() : undefined);
		if (!rect) return;
		const margin = options.viewportMargin ?? 12;
		node.style.maxHeight = `${Math.min(Number.isFinite(maxHeight) ? maxHeight : Infinity, Math.max(0, window.innerHeight - margin * 2))}px`;
		node.style.maxWidth = `${Math.min(Number.isFinite(maxWidth) ? maxWidth : Infinity, Math.max(0, window.innerWidth - margin * 2))}px`;
		if (overflowY !== 'hidden') node.style.overflowY = 'auto';
		const menu = node.getBoundingClientRect();
		const next = [
			rect.top,
			rect.left,
			rect.width,
			rect.height,
			menu.width,
			menu.height,
			window.innerWidth,
			window.innerHeight
		].join(':');
		if (signature === next) return;
		signature = next;
		const box = popupPosition(rect, menu, options);
		node.style.top = `${box.top}px`;
		node.style.left = `${box.left}px`;
		node.style.visibility = 'visible';
	};
	const follow = () => {
		position();
		frame = requestAnimationFrame(follow);
	};
	position();
	frame = requestAnimationFrame(follow);
	// Track scrolling and changing content immediately; rAF also follows window dragging.
	const scroll = (event: Event) => {
		if (!(event.target instanceof Node && node.contains(event.target))) {
			signature = '';
			position();
		}
	};
	window.addEventListener('resize', position);
	window.addEventListener('scroll', scroll, true);
	return {
		update(next: PopupOptions) {
			options = next;
			signature = '';
			registration?.update({
				kind: 'popover',
				focusOnOpen: false,
				trapFocus: false,
				...options,
				portal: false,
				anchor: () => options.anchor?.() ?? fallbackAnchor
			});
			position();
		},
		destroy() {
			cancelAnimationFrame(frame);
			window.removeEventListener('resize', position);
			window.removeEventListener('scroll', scroll, true);
			registration?.destroy();
			if (options.portal) node.remove();
			if (typeof node.hidePopover === 'function' && node.matches(':popover-open'))
				node.hidePopover();
			if (savedPopover === null) node.removeAttribute('popover');
			else node.setAttribute('popover', savedPopover);
			if (savedStyle === null) node.removeAttribute('style');
			else node.setAttribute('style', savedStyle);
		}
	};
}

/** Details flyouts register only while open, rather than taking Escape while closed. */
export function dismissDetails(node: HTMLDetailsElement, close?: () => void) {
	let registration: ReturnType<typeof overlay> | undefined;
	let placement: ReturnType<typeof anchoredPopup> | undefined;
	const sync = () => {
		if (node.open && !registration) {
			const content = node.querySelector<HTMLElement>(':scope > :not(summary)');
			if (content && !content.hasAttribute('popover'))
				placement = anchoredPopup(content, {
					manageOverlay: false,
					anchor: () => node.querySelector('summary'),
					placement: 'bottom-end',
					offset: 6,
					viewportMargin: 8
				});
			registration = overlay(node, {
				kind: 'popover',
				onClose:
					close ??
					(() => {
						node.open = false;
					}),
				focusOnOpen: false,
				trapFocus: false
			});
		}
		if (!node.open && registration) {
			placement?.destroy();
			placement = undefined;
			registration.destroy();
			registration = undefined;
		}
	};
	node.addEventListener('toggle', sync);
	sync();
	return {
		destroy() {
			node.removeEventListener('toggle', sync);
			placement?.destroy();
			registration?.destroy();
		}
	};
}
