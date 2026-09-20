<script lang="ts">
	/**
	 * Drag handle between two panes. Visual language matches
	 * {@link ResizableSidePanel}'s divider (hairline + centered pill).
	 */
	import { onDestroy } from 'svelte';
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
	let tracked = false;

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

	function trackWindow() {
		if (tracked) return;
		tracked = true;
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', endDrag);
		window.addEventListener('pointercancel', endDrag);
	}

	function untrackWindow() {
		if (!tracked) return;
		tracked = false;
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', endDrag);
		window.removeEventListener('pointercancel', endDrag);
	}

	function endDrag(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.pointerId) return;
		try {
			host?.releasePointerCapture?.(e.pointerId);
		} catch {
			// Capture may already be gone (element re-rendered, pointer vanished);
			// releasing must never abort the state reset below.
		}
		if (host) host.style.removeProperty('pointer-events');
		drag = null;
		dragging = false;
		untrackWindow();
	}

	// Track the active drag on the window, not the element: if pointer capture
	// silently failed (or was implicitly released), element-only listeners stop
	// seeing moves and — worse — never see the pointerup, leaving the drag
	// armed so that later mere hovers keep resizing the split.
	//
	// The listeners attach synchronously in onPointerDown, not in an effect:
	// effects run after the state flush, so a quick press-drag-release could
	// dispatch its moves (and its pointerup) before the effect attached —
	// swallowing the whole flick and leaving the drag armed.
	onDestroy(() => {
		untrackWindow();
	});

	function onPointerDown(e: PointerEvent) {
		if (disabled || e.button !== 0) return;
		const hostEl = e.currentTarget as HTMLElement;
		// Peek under the pill: on a narrow pane the centered grab can still
		// overlap overlay chrome (zoom cluster). Hide the handle so
		// elementFromPoint sees what's beneath — children have pointer-events
		// auto, so toggling the parent's pointer-events is not enough.
		const prevVis = hostEl.style.visibility;
		hostEl.style.visibility = 'hidden';
		const under = document.elementFromPoint(e.clientX, e.clientY);
		hostEl.style.visibility = prevVis;
		if (under && !hostEl.contains(under)) {
			const chrome = under.closest(
				'button, a, input, textarea, select, [role="button"], [role="slider"]'
			);
			if (chrome instanceof HTMLElement) {
				chrome.click();
				return;
			}
		}
		e.preventDefault();
		// Re-enable the full strip for the duration of the drag so capture
		// keeps working as the pointer moves off the pill.
		hostEl.style.setProperty('pointer-events', 'auto', 'important');
		try {
			hostEl.setPointerCapture?.(e.pointerId);
		} catch {
			// Some synthetic/inactive pointers refuse capture; the window
			// listeners above keep the drag working without it.
		}
		drag = {
			pointerId: e.pointerId,
			grabOffset: (axis === 'x' ? e.clientX : e.clientY) - handleCenter()
		};
		dragging = true;
		// Synchronous: a quick flick's moves/pointerup may dispatch before an
		// effect could attach, which previously swallowed the whole drag.
		trackWindow();
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
		/* The strip still *paints* the hairline across the whole split, but
		   pointer events stay on the centered pill. A full-width 11px hit
		   (worse on touch, where the OS inflates it toward ~44px) covered the
		   bottom-right zoom cluster — only a thin top strip of Width/Fit
		   stayed clickable. */
		pointer-events: none;
	}
	.pl-handle.x {
		width: 11px;
		margin: 0 -5px;
	}
	.pl-handle.y {
		height: 11px;
		margin: -5px 0;
	}
	.pl-hairline {
		position: absolute;
		background: color-mix(in srgb, var(--border, #334155) 80%, transparent);
		pointer-events: none;
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
		pointer-events: auto;
	}
	.pl-handle.x .pl-pill {
		width: 3px;
		height: 28px;
		cursor: col-resize;
	}
	.pl-handle.y .pl-pill {
		width: 28px;
		height: 3px;
		cursor: row-resize;
	}
	/* Fat grab around the visible pill only — not the corners, where overlay
	   chrome (zoom, tool rail) lives. */
	.pl-pill::before {
		content: '';
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
	}
	.pl-handle.x .pl-pill::before {
		width: 16px;
		height: 96px;
	}
	.pl-handle.y .pl-pill::before {
		width: 96px;
		height: 16px;
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
