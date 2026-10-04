import { anchoredPopup } from '@shared-packages/design-system';
/**
 * Body-portaled tooltip for `[data-tooltip]` hosts whose CSS ::after tips
 * would be clipped or stacked under siblings (overflow containers, z-0
 * overlays, later list rows). Styling lives in design-system's
 * `tooltip.css` (`.ds-float-tooltip`, already `pointer-events: none`).
 */
export function createFloatTooltip(opts?: { zIndex?: number; delayMs?: number }) {
	const zIndex = opts?.zIndex ?? 20000;
	const delayMs = opts?.delayMs ?? 120;
	let el: HTMLDivElement | null = null;
	let popup: ReturnType<typeof anchoredPopup> | undefined;
	let showTimer: ReturnType<typeof setTimeout> | null = null;

	function ensure(): HTMLDivElement {
		if (el && document.body.contains(el)) return el;
		const node = document.createElement('div');
		node.className = 'ds-float-tooltip';
		node.setAttribute('role', 'tooltip');
		node.setAttribute('data-testid', 'float-tooltip');
		node.style.zIndex = String(zIndex);
		document.body.appendChild(node);
		el = node;
		return node;
	}

	function hide() {
		if (showTimer) {
			clearTimeout(showTimer);
			showTimer = null;
		}
		popup?.destroy();
		popup = undefined;
		if (el) {
			el.style.opacity = '0';
			el.style.visibility = 'hidden';
		}
	}

	function show(anchor: HTMLElement, text: string, pos: string | null) {
		if (!text) return;
		const tip = ensure();
		tip.textContent = text;
		tip.style.opacity = '0';
		tip.style.visibility = 'hidden';
		tip.style.left = '0';
		tip.style.top = '0';
		popup?.destroy();
		popup = anchoredPopup(tip, {
			anchor: () => anchor,
			manageOverlay: false,
			placement:
				pos === 'bottom-left'
					? 'bottom-end'
					: pos === 'bottom-right'
						? 'bottom-start'
						: 'bottom-center',
			offset: 6,
			viewportMargin: 8
		});
		tip.style.opacity = '1';
	}

	function onPointerOver(e: Event) {
		const t = (e.target as Element | null)?.closest?.('[data-tooltip]') as HTMLElement | null;
		if (!t || !e.currentTarget || !(e.currentTarget as HTMLElement).contains(t)) return;
		const text = t.getAttribute('data-tooltip') ?? '';
		const pos = t.getAttribute('data-tooltip-pos');
		if (showTimer) clearTimeout(showTimer);
		showTimer = setTimeout(() => show(t, text, pos), delayMs);
	}

	function onPointerOut(e: Event) {
		const related = (e as MouseEvent).relatedTarget as Node | null;
		const root = e.currentTarget as HTMLElement;
		if (related && root.contains(related)) {
			const next = (related as Element).closest?.('[data-tooltip]');
			if (next && root.contains(next)) return;
		}
		hide();
	}

	function destroy() {
		hide();
		el?.remove();
		el = null;
	}

	return { onPointerOver, onPointerOut, hide, destroy };
}
