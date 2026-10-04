/** One ownership stack for dialogs and anchored popups, independent of Svelte. */
export interface OverlayOptions {
	kind?: 'modal' | 'popover';
	panel?: string | HTMLElement;
	anchor?: () => HTMLElement | null | undefined;
	onClose?: () => void;
	onEscape?: () => void;
	closeOnEscape?: boolean;
	closeOnOutside?: boolean;
	closeOnBackdrop?: boolean;
	focusOnOpen?: boolean;
	trapFocus?: boolean;
	restoreFocus?: boolean;
	lockScroll?: boolean;
	/** Workspace-wide modal; retain false for intentionally pane-local shells. */
	portal?: boolean;
}

type Entry = {
	id: symbol;
	node?: HTMLElement;
	options: OverlayOptions;
	previous: HTMLElement | null;
	ancestors: HTMLElement[];
};
function createOverlayController() {
	const stack: Entry[] = [];
	let overflow: string | null = null;
	let listening = false;
	const inertSaved = new Map<HTMLElement, boolean>();
	let pointerStartedOutside = new Set<symbol>();
	const focusSelector =
		'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

	function panel(entry: Entry) {
		const value = entry.options.panel;
		return typeof value === 'string'
			? (entry.node?.querySelector<HTMLElement>(value) ?? entry.node)
			: (value ?? entry.node);
	}
	function controls(entry: Entry) {
		return [...(panel(entry)?.querySelectorAll<HTMLElement>(focusSelector) ?? [])].filter(
			(el) =>
				el.tabIndex >= 0 &&
				!el.closest('[hidden], [inert], [aria-hidden="true"]') &&
				getComputedStyle(el).visibility !== 'hidden' &&
				getComputedStyle(el).display !== 'none'
		);
	}
	function inside(entry: Entry, target: EventTarget | null) {
		return (
			target instanceof Node &&
			(entry.node?.contains(target) || entry.options.anchor?.()?.contains(target))
		);
	}
	function dismiss(entry: Entry) {
		entry.options.onClose?.();
	}
	function keydown(event: KeyboardEvent) {
		const top = stack.at(-1);
		if (!top) return;
		if (event.key === 'Escape') {
			event.stopImmediatePropagation();
			if (event.defaultPrevented) return;
			// Consume even when dismissal is disabled: the parent must stay open.
			event.preventDefault();
			if (top.options.closeOnEscape !== false) (top.options.onEscape ?? top.options.onClose)?.();
			return;
		}
		if (event.key !== 'Tab' || event.defaultPrevented) return;
		const owner = [...stack]
			.reverse()
			.find((entry) => entry.options.trapFocus ?? entry.options.kind === 'modal');
		if (!owner || !panel(owner)) return;
		const children = stack.slice(stack.indexOf(owner) + 1);
		const withinOwner =
			panel(owner)?.contains(document.activeElement) ||
			children.some((entry) => inside(entry, document.activeElement));
		const list = [...new Set([controls(owner), ...children.map(controls)].flat())],
			first = list[0],
			last = list.at(-1);
		if (!first) {
			event.preventDefault();
			panel(owner)?.focus();
		} else if (event.shiftKey && (document.activeElement === first || !withinOwner)) {
			event.preventDefault();
			last?.focus();
		} else if (!event.shiftKey && (document.activeElement === last || !withinOwner)) {
			event.preventDefault();
			first.focus();
		}
	}
	function directWindowKeydown(event: KeyboardEvent) {
		if (!(event.target instanceof Node)) keydown(event);
	}
	function popupKeydown(event: KeyboardEvent) {
		// Editor/terminal menus retain focus on their trigger or editor. Own
		// Escape before that underlying surface can clear selection or close.
		if (event.key === 'Escape' && stack.at(-1)?.options.kind === 'popover') keydown(event);
	}
	function pointerdown(event: PointerEvent) {
		pointerStartedOutside = new Set(
			stack
				.filter((entry) => !panel(entry)?.contains(event.target as Node))
				.map((entry) => entry.id)
		);
		// Snapshot: a synchronous close must not make the same event reach its parent twice.
		for (const entry of [...stack].reverse()) {
			if (inside(entry, event.target)) break;
			if (entry.options.kind === 'modal') break;
			if (entry.options.closeOnOutside !== false) dismiss(entry);
		}
	}
	function click(event: MouseEvent) {
		const top = stack.at(-1);
		if (!top || top.options.kind !== 'modal') return;
		if (!inside(top, event.target) || panel(top)?.contains(event.target as Node)) return;
		// Own scrim clicks even when disabled, so local/legacy callbacks cannot bypass the policy.
		event.stopImmediatePropagation();
		if (top.options.closeOnBackdrop === false) return;
		// Keyboard activation has detail=0; pointer drags must begin on the scrim.
		if (event.detail === 0 || pointerStartedOutside.has(top.id)) dismiss(top);
	}
	function synchronizeInert() {
		for (const [node, saved] of inertSaved) node.inert = saved;
		inertSaved.clear();
		let modalIndex = stack.length - 1;
		while (modalIndex >= 0 && stack[modalIndex]?.options.kind !== 'modal') modalIndex--;
		if (modalIndex < 0 || !stack[modalIndex]?.node) return;
		const active = stack.slice(modalIndex).flatMap((entry) => (entry.node ? [entry.node] : []));
		const visit = (parent: HTMLElement) => {
			for (const child of parent.children) {
				if (!(child instanceof HTMLElement) || ['SCRIPT', 'STYLE', 'LINK'].includes(child.tagName))
					continue;
				if (active.includes(child)) continue;
				if (active.some((node) => child.contains(node))) visit(child);
				else {
					inertSaved.set(child, child.inert);
					child.inert = true;
				}
			}
		};
		visit(document.body);
	}
	function synchronize() {
		if (typeof document === 'undefined') return;
		const locked = stack.some(
			(entry) => entry.options.lockScroll ?? entry.options.kind === 'modal'
		);
		if (locked && overflow === null) {
			overflow = document.body.style.overflow;
			document.body.style.overflow = 'hidden';
		}
		if (!locked && overflow !== null) {
			document.body.style.overflow = overflow;
			overflow = null;
		}
		if (stack.length && !listening) {
			document.addEventListener('keydown', popupKeydown, true);
			document.addEventListener('keydown', keydown);
			window.addEventListener('keydown', directWindowKeydown);
			document.addEventListener('pointerdown', pointerdown, true);
			document.addEventListener('click', click, true);
			listening = true;
		} else if (!stack.length && listening) {
			document.removeEventListener('keydown', popupKeydown, true);
			document.removeEventListener('keydown', keydown);
			window.removeEventListener('keydown', directWindowKeydown);
			document.removeEventListener('pointerdown', pointerdown, true);
			document.removeEventListener('click', click, true);
			pointerStartedOutside.clear();
			listening = false;
		}
		synchronizeInert();
		stack.forEach((entry, depth) => {
			if (entry.node) entry.node.style.zIndex = String(overlayBaseZ() + depth * 10);
		});
	}
	function overlayBaseZ() {
		if (typeof document === 'undefined') return 2000;
		const raw = getComputedStyle(document.documentElement).getPropertyValue('--z-modal-backdrop');
		return Number.parseInt(raw, 10) || 2000;
	}
	function hasOpenOverlay() {
		return stack.length > 0;
	}
	function isTopOverlay(id: symbol) {
		return stack.at(-1)?.id === id;
	}
	function overlayDepth(id: symbol) {
		return stack.findIndex((entry) => entry.id === id);
	}

	function registerOverlay(id: symbol, node: HTMLElement | undefined, options: OverlayOptions) {
		const ancestors: HTMLElement[] = [];
		for (let parent = node?.parentElement; parent; parent = parent.parentElement)
			ancestors.push(parent);
		const previous =
			typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		const entry: Entry = {
			id,
			node,
			options,
			ancestors,
			previous:
				options.kind === 'popover' && options.focusOnOpen
					? (options.anchor?.() ?? previous)
					: typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
						? document.activeElement
						: null
		};
		if (options.kind === 'modal') {
			for (const other of [...stack])
				if (
					other.options.kind !== 'modal' &&
					!other.ancestors.includes(node!) &&
					!node?.contains(other.options.anchor?.() ?? null)
				)
					dismiss(other);
		}
		// Svelte mounts child actions before parent actions; retain DOM nesting order.
		const child = stack.findIndex(
			(other) =>
				node &&
				(other.ancestors.includes(node) ||
					node.contains(other.node ?? null) ||
					node.contains(other.options.anchor?.() ?? null))
		);
		if (child < 0) stack.push(entry);
		else stack.splice(child, 0, entry);
		synchronize();
		queueMicrotask(() => {
			synchronize();
			if (
				!stack.includes(entry) ||
				!isTopOverlay(id) ||
				!(options.focusOnOpen ?? options.kind === 'modal')
			)
				return;
			const root = panel(entry);
			if (root && !root.hasAttribute('tabindex')) root.tabIndex = -1;
			(root?.querySelector<HTMLElement>('[data-autofocus]') ?? controls(entry)[0] ?? root)?.focus();
		});
		return {
			update(next: OverlayOptions) {
				entry.options = next;
				synchronize();
			},
			destroy() {
				const index = stack.indexOf(entry);
				if (index < 0) return;
				const wasTop = isTopOverlay(id);
				const active = typeof document === 'undefined' ? null : document.activeElement;
				stack.splice(index, 1);
				synchronize();
				if (
					wasTop &&
					entry.options.restoreFocus !== false &&
					entry.previous?.isConnected &&
					(active === document.body || !active?.isConnected || inside(entry, active))
				)
					entry.previous.focus();
			}
		};
	}

	return { registerOverlay, isTopOverlay, overlayDepth, overlayBaseZ, hasOpenOverlay };
}

// Linked packages can arrive through more than one Vite module graph. Ownership
// belongs to the browser document, rather than to an import path or app bundle.
const registryKey = Symbol.for('@shared-packages/design-system/overlay-controller/v1');
const registries = globalThis as unknown as Record<
	symbol,
	ReturnType<typeof createOverlayController>
>;
const controller = (registries[registryKey] ??= createOverlayController());
export const { registerOverlay, isTopOverlay, overlayDepth, overlayBaseZ, hasOpenOverlay } =
	controller;

/** Svelte action: keep existing markup/styles, share lifecycle and input policy. */
export function overlay(node: HTMLElement, options: OverlayOptions = {}) {
	const savedZ = node.style.zIndex;
	const id = Symbol('overlay');
	const registration = registerOverlay(id, node, options);
	if (options.portal) {
		document.body.appendChild(node);
		node.style.position = 'fixed';
	}
	return {
		update(next: OverlayOptions) {
			options = next;
			registration.update(next);
		},
		destroy() {
			registration.destroy();
			node.style.zIndex = savedZ;
			if (options.portal) node.remove();
		}
	};
}
