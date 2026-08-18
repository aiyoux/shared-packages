<script lang="ts">
	/**
	 * Drag handle between two panes. Visual language matches
	 * {@link ResizableSidePanel}'s divider (hairline + centered pill).
	 */
	let {
		axis,
		ariaLabel = 'Resize panes',
		disabled = false,
		onRatioDelta
	}: {
		/** `x` = side-by-side split (col-resize). `y` = stacked split (row-resize). */
		axis: 'x' | 'y';
		ariaLabel?: string;
		disabled?: boolean;
		/** Called with pointer delta as a fraction of the split container size. */
		onRatioDelta: (deltaRatio: number) => void;
	} = $props();

	let dragging = $state(false);
	let host: HTMLElement | undefined = $state();
	let drag:
		| { pointerId: number; last: number; size: number }
		| null = null;

	function splitSize(): number {
		const parent = host?.parentElement;
		if (!parent) return 1;
		return Math.max(1, axis === 'x' ? parent.clientWidth : parent.clientHeight);
	}

	function onPointerDown(e: PointerEvent) {
		if (disabled || e.button !== 0) return;
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		drag = {
			pointerId: e.pointerId,
			last: axis === 'x' ? e.clientX : e.clientY,
			size: splitSize()
		};
		dragging = true;
	}

	function onPointerMove(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.pointerId) return;
		const now = axis === 'x' ? e.clientX : e.clientY;
		const deltaPx = now - drag.last;
		drag.last = now;
		if (deltaPx === 0) return;
		onRatioDelta(deltaPx / drag.size);
	}

	function onPointerUp(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.pointerId) return;
		(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
		drag = null;
		dragging = false;
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
	data-testid="pl-handle"
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
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
		inset: 0 auto 0 50%;
		width: 1px;
		transform: translateX(-50%);
	}
	.pl-handle.y .pl-hairline {
		inset: 50% 0 auto 0;
		height: 1px;
		transform: translateY(-50%);
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
