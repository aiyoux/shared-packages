<script lang="ts">
	/**
	 * Drag handle between two panes. Visual language matches
	 * {@link ResizableSidePanel}'s divider (hairline + centered pill).
	 */
	let {
		axis,
		ariaLabel = 'Resize panes',
		disabled = false,
		testid = 'pl-handle',
		onRatioDelta
	}: {
		/** `x` = side-by-side split (col-resize). `y` = stacked split (row-resize). */
		axis: 'x' | 'y';
		ariaLabel?: string;
		disabled?: boolean;
		testid?: string;
		/** Called with pointer delta as a fraction of the split container size. */
		onRatioDelta: (deltaRatio: number) => void;
	} = $props();

	let dragging = $state(false);
	let host: HTMLElement | undefined = $state();
	let drag: { pointerId: number; grabOffset: number } | null = null;

	function splitSize(): number {
		const parent = host?.parentElement;
		if (!parent) return 1;
		return Math.max(1, axis === 'x' ? parent.clientWidth : parent.clientHeight);
	}

	/** The handle's center along the drag axis, in client coordinates. */
	function handleCenter(): number {
		if (!host) return 0;
		const r = host.getBoundingClientRect();
		return axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2;
	}

	function endDrag(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.pointerId) return;
		try {
			host?.releasePointerCapture?.(e.pointerId);
		} catch {
			// Capture may already be gone (element re-rendered, pointer vanished);
			// releasing must never abort the state reset below.
		}
		drag = null;
		dragging = false;
	}

	// Track the active drag on the window, not the element: if pointer capture
	// silently failed (or was implicitly released), element-only listeners stop
	// seeing moves and — worse — never see the pointerup, leaving the drag
	// armed so that later mere hovers keep resizing the split.
	$effect(() => {
		if (!dragging) return;
		const move = (e: PointerEvent) => onPointerMove(e);
		const end = (e: PointerEvent) => endDrag(e);
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', end);
		window.addEventListener('pointercancel', end);
		return () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', end);
			window.removeEventListener('pointercancel', end);
		};
	});

	function onPointerDown(e: PointerEvent) {
		if (disabled || e.button !== 0) return;
		e.preventDefault();
		try {
			(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		} catch {
			// Some synthetic/inactive pointers refuse capture; the window
			// listeners above keep the drag working without it.
		}
		drag = {
			pointerId: e.pointerId,
			grabOffset: (axis === 'x' ? e.clientX : e.clientY) - handleCenter()
		};
		dragging = true;
	}

	function onPointerMove(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.pointerId) return;
		// A drag only exists while the primary button is down. Without this
		// guard, a pointerup missed elsewhere leaves the drag armed and every
		// later hover nudges the split away from the pointer.
		if (!(e.buttons & 1)) {
			endDrag(e);
			return;
		}
		const now = axis === 'x' ? e.clientX : e.clientY;
		// Absolute anchor: each move drives the handle to (pointer − grab
		// offset), measured from where the handle actually is right now. The
		// DOM has settled by the time the next pointermove arrives, so the
		// measurement is current; clamps, mid-drag re-layouts and
		// coalesced/lost events can therefore never accumulate into a
		// pointer/handle offset, and dragging back off a clamp re-attaches
		// instantly instead of lagging behind.
		const deltaPx = now - drag.grabOffset - handleCenter();
		if (deltaPx === 0) return;
		onRatioDelta(deltaPx / splitSize());
	}

	function onKeyDown(e: KeyboardEvent) {
		if (disabled) return;
		const step = e.shiftKey ? 0.08 : 0.03;
		const dec = axis === 'x' ? e.key === 'ArrowLeft' : e.key === 'ArrowUp';
		const inc = axis === 'x' ? e.key === 'ArrowRight' : e.key === 'ArrowDown';
		if (inc) {
			e.preventDefault();
			onRatioDelta(step);
		} else if (dec) {
			e.preventDefault();
			onRatioDelta(-step);
		}
	}
</script>

<!-- A split-pane divider. `separator` is the correct role and it is genuinely
     focusable/operable by keyboard, so the generic non-interactive warnings
     do not apply. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	bind:this={host}
	class="pl-handle"
	class:x={axis === 'x'}
	class:y={axis === 'y'}
	class:dragging
	role="separator"
	aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
	aria-label={ariaLabel}
	aria-disabled={disabled}
	tabindex="0"
	data-testid={testid}
	onpointerdown={onPointerDown}
	onkeydown={onKeyDown}
>
	<span class="pl-hairline" aria-hidden="true"></span>
	<span class="pl-pill" aria-hidden="true"></span>
</div>

<style>
	.pl-handle {
		position: relative;
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: center;
		touch-action: none;
		z-index: 2;
	}
	.pl-handle.x {
		width: 11px;
		margin: 0 -5px;
		cursor: col-resize;
	}
	.pl-handle.y {
		height: 11px;
		margin: -5px 0;
		cursor: row-resize;
	}
	.pl-hairline {
		position: absolute;
		background: color-mix(in srgb, var(--border, #334155) 80%, transparent);
	}
	.pl-handle.x .pl-hairline {
		inset: 0 auto 0 5px;
		width: 1px;
	}
	.pl-handle.y .pl-hairline {
		inset: 5px 0 auto 0;
		height: 1px;
	}
	.pl-pill {
		position: relative;
		border-radius: 999px;
		background: color-mix(in srgb, var(--border, #64748b) 90%, transparent);
		transition: background 0.12s ease;
	}
	.pl-handle.x .pl-pill {
		width: 3px;
		height: 28px;
	}
	.pl-handle.y .pl-pill {
		width: 28px;
		height: 3px;
	}
	.pl-handle:hover .pl-pill,
	.pl-handle:focus-visible .pl-pill,
	.pl-handle.dragging .pl-pill {
		background: var(--accent, #38bdf8);
	}
	.pl-handle:focus-visible {
		outline: none;
	}
</style>
