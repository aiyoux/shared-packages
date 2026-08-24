/**
 * Generic tree drag helpers. Pure functions + a pointer-drag factory that
 * paints zone classes on the DOM — no runes, so a host with xterm (or any
 * heavy subtree) can drag without re-rendering on pointermove.
 */
import type { DropPolicy, TreeDrag, Zone } from './tree-model.ts';

export type { DropPolicy, TreeDrag, TreeNode, Zone } from './tree-model.ts';
export {
	flattenVisible,
	indexNodes,
	isExpandable,
	keyboardTarget,
	toIdSet
} from './tree-model.ts';

export const ZONE_CLASSES = ['dnd-zone-before', 'dnd-zone-after', 'dnd-zone-into'] as const;

export const DEFAULT_ROW_SELECTOR = '[data-tree-row], [data-dnd-row]';
export const DEFAULT_BAR_SELECTOR = ':scope > [data-tree-bar], :scope > [data-dnd-bar]';
export const ROW_DRAG_THRESHOLD = 6;

/**
 * Selector matching elements that should NOT start a drag (their own click
 * handlers still fire). CRITICAL: this must NOT include `button` or
 * `[role="button"]` — the row bar itself is often a `<button>` and must remain
 * a drag source. Only the action-icon cluster and chevron are marked
 * `data-no-drag`.
 */
export const GUARD_SELECTOR =
	'input, textarea, select, [contenteditable="true"], [role="checkbox"], [data-no-drag]';

export function isInteractiveDragTarget(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	return Boolean(target.closest(GUARD_SELECTOR));
}

/** Pass to `move*` store functions to append to the end of the target list. */
export const APPEND = Number.MAX_SAFE_INTEGER;

/**
 * Map cursor Y to a drop zone, restricted to the zones the (drag, target)
 * pair actually allows.
 *
 * Prefer passing the *row header* rect (the bar), not the full expanded
 * wrapper. Expanded children make the wrapper very tall; using that height
 * made the header always land in the "before" half.
 *
 * When `expandedBelow` is true (cursor is below the header, inside nested
 * content of this row), force `after` for sibling reorders.
 */
export function pickZone(
	rect: DOMRect,
	clientY: number,
	allowed: Zone[],
	opts?: { expandedBelow?: boolean }
): Zone | null {
	if (allowed.length === 0) return null;
	if (allowed.length === 1) return allowed[0];
	if (opts?.expandedBelow && allowed.includes('after')) return 'after';
	const y = clientY - rect.top;
	const h = rect.height || 1;
	if (allowed.includes('into') && allowed.includes('before') && allowed.includes('after')) {
		if (y < h * 0.28) return 'before';
		if (y > h * 0.72) return 'after';
		return 'into';
	}
	return y < h / 2
		? allowed.includes('before')
			? 'before'
			: allowed[0]
		: allowed.includes('after')
			? 'after'
			: allowed[allowed.length - 1];
}

/**
 * Post-removal insertion index for a same-list sibling reorder, validated
 * against `moveItem`'s `if (toIndex < 0 || toIndex > arr.length) return`
 * guard (which checks `toIndex` against the ORIGINAL pre-splice length).
 */
export function insertIndex(from: number, target: number, zone: Zone): number {
	if (from === target) return from;
	const finalTarget = from < target ? target - 1 : target;
	return zone === 'before' ? finalTarget : finalTarget + 1;
}

export function rowFromPoint(
	x: number,
	y: number,
	selector: string = DEFAULT_ROW_SELECTOR
): HTMLElement | null {
	return document.elementFromPoint(x, y)?.closest<HTMLElement>(selector) ?? null;
}

export function parentRow(
	el: HTMLElement,
	selector: string = DEFAULT_ROW_SELECTOR
): HTMLElement | null {
	return el.parentElement?.closest<HTMLElement>(selector) ?? null;
}

export function barRect(row: HTMLElement, barSelector: string = DEFAULT_BAR_SELECTOR): DOMRect {
	const bar = row.querySelector<HTMLElement>(barSelector);
	return (bar ?? row).getBoundingClientRect();
}

export type PointerDragMods = { shiftKey: boolean };

export type PointerDragOptions<K extends string = string, M = unknown> = {
	dropPolicy: DropPolicy<K, M>;
	onCommit: (drag: TreeDrag<K, M>, over: TreeDrag<K, M>, zone: Zone, mods: PointerDragMods) => void;
	/** Fired on pointerup after a drag that did not land on a valid tree row. */
	onExternalDrop?: (drag: TreeDrag<K, M>, clientX: number, clientY: number) => void;
	nodeFromEl: (el: HTMLElement) => TreeDrag<K, M> | null;
	isSelfDrop?: (drag: TreeDrag<K, M>, over: TreeDrag<K, M>) => boolean;
	rowSelector?: string;
	barSelector?: string;
	threshold?: number;
	onActiveChange?: (active: boolean) => void;
};

export type PointerDragSession<K extends string = string, M = unknown> = {
	onPointerDown: (e: PointerEvent, drag: TreeDrag<K, M>) => void;
	didDrag: () => boolean;
};

function defaultSelfDrop<K extends string, M>(drag: TreeDrag<K, M>, over: TreeDrag<K, M>): boolean {
	return drag.id === over.id && drag.kind === over.kind;
}

/**
 * Pointer-drag factory. Live drop state is plain fields + classList — never
 * `$state` — so pointermove does not re-render the host.
 */
export function createPointerDrag<K extends string = string, M = unknown>(
	opts: PointerDragOptions<K, M>
): PointerDragSession<K, M> {
	const rowSelector = opts.rowSelector ?? DEFAULT_ROW_SELECTOR;
	const barSelector = opts.barSelector ?? DEFAULT_BAR_SELECTOR;
	const threshold = opts.threshold ?? ROW_DRAG_THRESHOLD;
	const isSelf = opts.isSelfDrop ?? defaultSelfDrop;

	let liveDropEl: HTMLElement | null = null;
	let liveOver: TreeDrag<K, M> | null = null;
	let liveZone: Zone | null = null;
	let stop: (() => void) | null = null;
	let committed = false;

	function clearPaint() {
		if (liveDropEl) {
			liveDropEl.classList.remove(...ZONE_CLASSES);
			liveDropEl = null;
		}
		liveOver = null;
		liveZone = null;
	}

	function paint(el: HTMLElement | null, over: TreeDrag<K, M> | null, zone: Zone | null) {
		if (liveDropEl && liveDropEl !== el) liveDropEl.classList.remove(...ZONE_CLASSES);
		else if (liveDropEl && liveDropEl === el) liveDropEl.classList.remove(...ZONE_CLASSES);
		liveDropEl = el;
		liveOver = over;
		liveZone = zone;
		if (el && zone) el.classList.add(`dnd-zone-${zone}`);
	}

	function setActive(active: boolean) {
		document.body.classList.toggle('tree-dnd-active', active);
		opts.onActiveChange?.(active);
	}

	function onPointerDown(e: PointerEvent, drag: TreeDrag<K, M>) {
		committed = false;
		if (e.button !== 0) return;
		if (isInteractiveDragTarget(e.target)) return;
		e.stopPropagation();

		let activated = false;
		const startX = e.clientX;
		const startY = e.clientY;
		const sourceEl = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
		const rowEl = sourceEl?.closest<HTMLElement>(rowSelector) ?? sourceEl;

		const move = (ev: PointerEvent) => {
			if (!activated) {
				if (Math.hypot(ev.clientX - startX, ev.clientY - startY) <= threshold) return;
				activated = true;
				committed = true;
				rowEl?.classList.add('dnd-dragging');
				setActive(true);
			}

			const hitEl = rowFromPoint(ev.clientX, ev.clientY, rowSelector);
			let el: HTMLElement | null = hitEl;
			let over = el ? opts.nodeFromEl(el) : null;
			let walkedUp = false;
			if (over && el) {
				let self = isSelf(drag, over);
				let allowed = self ? [] : opts.dropPolicy(drag, over);
				while ((self || allowed.length === 0) && el) {
					el = parentRow(el, rowSelector);
					walkedUp = true;
					over = el ? opts.nodeFromEl(el) : null;
					if (!over || !el) break;
					self = isSelf(drag, over);
					allowed = self ? [] : opts.dropPolicy(drag, over);
				}
			}
			if (!over || !el) {
				paint(null, null, null);
				return;
			}
			if (isSelf(drag, over)) {
				paint(null, null, null);
				return;
			}
			const allowed = opts.dropPolicy(drag, over);
			if (allowed.length === 0) {
				paint(null, null, null);
				return;
			}
			const bar = barRect(el, barSelector);
			const expandedBelow = walkedUp || ev.clientY > bar.bottom;
			const zone = pickZone(bar, ev.clientY, allowed, { expandedBelow });
			if (!zone) {
				paint(null, null, null);
				return;
			}
			paint(el, over, zone);
		};

		const finish = (ev: PointerEvent) => {
			if (activated && liveOver && liveZone) {
				opts.onCommit(drag, liveOver, liveZone, { shiftKey: ev.shiftKey });
			} else if (activated) {
				opts.onExternalDrop?.(drag, ev.clientX, ev.clientY);
			}
			stop?.();
			stop = null;
			rowEl?.classList.remove('dnd-dragging');
			clearPaint();
			setActive(false);
		};

		stop?.();
		document.addEventListener('pointermove', move, { passive: true });
		document.addEventListener('pointerup', finish, { once: true });
		document.addEventListener('pointercancel', finish, { once: true });
		stop = () => {
			document.removeEventListener('pointermove', move);
			document.removeEventListener('pointerup', finish);
			document.removeEventListener('pointercancel', finish);
		};
	}

	return {
		onPointerDown,
		didDrag: () => committed
	};
}
