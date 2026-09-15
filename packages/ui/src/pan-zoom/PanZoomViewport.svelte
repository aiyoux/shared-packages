<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
		canvasView,
		clampScale,
		pointerDistance,
		wheelZoomFactor,
		type Pan,
		type ZoomMode
	} from './panZoom.js';
	import PanZoomControls from './PanZoomControls.svelte';

	let {
		contentWidth,
		contentHeight,
		testidPrefix = 'pz',
		children
	}: {
		contentWidth: number;
		contentHeight: number;
		testidPrefix?: string;
		children: Snippet;
	} = $props();

	let stageEl = $state<HTMLDivElement | null>(null);
	let stageSize = $state({ w: 0, h: 0 });
	let zoomMode = $state<ZoomMode>('fit');
	let manualScale = $state(1);
	let pan = $state<Pan>({ x: 0, y: 0 });
	let panDrag = $state<{ px: number; py: number; ox: number; oy: number } | null>(null);
	const pointers = new Map<number, { x: number; y: number }>();
	let pinch: { startDist: number; startScale: number } | null = null;

	const cw = $derived(Math.max(1, contentWidth));
	const ch = $derived(Math.max(1, contentHeight));
	const view = $derived(
		canvasView({
			mode: zoomMode,
			manualScale,
			pan,
			stageW: stageSize.w,
			stageH: stageSize.h,
			contentW: cw,
			contentH: ch
		})
	);

	$effect(() => {
		const el = stageEl;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const measure = () => {
			stageSize = { w: el.clientWidth, h: el.clientHeight };
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	});

	function resetPan() {
		pan = { x: 0, y: 0 };
	}
	function setManualScale(scale: number) {
		manualScale = clampScale(scale);
		zoomMode = 'manual';
	}
	function zoomBy(factor: number) {
		setManualScale(clampScale(view.scale * factor));
	}

	function onPointerDown(e: PointerEvent) {
		const target = e.target as Element;
		if (target.closest?.('.pz-chrome')) return;
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size === 2) {
			panDrag = null;
			const pts = [...pointers.values()];
			pinch = { startDist: pointerDistance(pts[0]!, pts[1]!), startScale: view.scale };
			e.preventDefault();
			return;
		}
		if (pointers.size > 2) return;
		e.preventDefault();
		panDrag = { px: e.clientX, py: e.clientY, ox: pan.x, oy: pan.y };
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
	}
	function onPointerMove(e: PointerEvent) {
		if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pinch && pointers.size >= 2) {
			e.preventDefault();
			const pts = [...pointers.values()];
			const dist = pointerDistance(pts[0]!, pts[1]!);
			if (pinch.startDist > 0 && dist > 0) {
				setManualScale(pinch.startScale * (dist / pinch.startDist));
			}
			return;
		}
		if (!panDrag) return;
		pan = { x: panDrag.ox + (e.clientX - panDrag.px), y: panDrag.oy + (e.clientY - panDrag.py) };
	}
	function onPointerUp(e: PointerEvent) {
		pointers.delete(e.pointerId);
		if (pointers.size < 2) pinch = null;
		panDrag = null;
	}

	$effect(() => {
		const el = stageEl;
		if (!el) return;
		const onWheel = (ev: WheelEvent) => {
			if ((ev.target as Element | null)?.closest?.('.pz-chrome')) return;
			ev.preventDefault();
			zoomBy(wheelZoomFactor(ev.deltaY));
		};
		const block = (ev: Event) => ev.preventDefault();
		const opts: AddEventListenerOptions = { passive: false };
		el.addEventListener('wheel', onWheel, opts);
		el.addEventListener('gesturestart', block, opts);
		el.addEventListener('gesturechange', block, opts);
		el.addEventListener('gestureend', block, opts);
		return () => {
			el.removeEventListener('wheel', onWheel, opts);
			el.removeEventListener('gesturestart', block, opts);
			el.removeEventListener('gesturechange', block, opts);
			el.removeEventListener('gestureend', block, opts);
		};
	});
</script>

<div class="pz-root" data-testid="{testidPrefix}-viewport">
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="pz-stage"
		bind:this={stageEl}
		data-testid="{testidPrefix}-stage"
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerUp}
	>
		<div
			class="pz-canvas"
			data-canvas-scale={view.scale}
			style="width:{cw}px;height:{ch}px;transform:scale({view.scale});left:{view.offsetX}px;top:{view.offsetY}px"
		>
			{@render children()}
		</div>
	</div>
	<div class="pz-chrome">
		<PanZoomControls
			scale={view.scale}
			mode={zoomMode}
			{testidPrefix}
			onZoomIn={() => zoomBy(1.25)}
			onZoomOut={() => zoomBy(1 / 1.25)}
			onReset={() => {
				setManualScale(1);
				resetPan();
			}}
			onFit={() => {
				zoomMode = 'fit';
				resetPan();
			}}
			onWidth={() => {
				zoomMode = 'width';
				resetPan();
			}}
		/>
	</div>
</div>

<style>
	.pz-root {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		min-height: 0;
		min-width: 0;
	}
	.pz-stage {
		position: relative;
		flex: 1 1 auto;
		min-height: 0;
		min-width: 0;
		overflow: hidden;
		touch-action: none;
		cursor: grab;
		background: var(--surface-1, #12141a);
	}
	.pz-stage:active {
		cursor: grabbing;
	}
	.pz-canvas {
		position: absolute;
		transform-origin: 0 0;
		overflow: hidden;
	}
	.pz-canvas :global(img),
	.pz-canvas :global(canvas),
	.pz-canvas :global(video) {
		width: 100%;
		height: 100%;
		display: block;
		object-fit: fill;
		user-select: none;
		-webkit-user-drag: none;
		pointer-events: none;
	}
	.pz-chrome {
		flex: 0 0 auto;
		display: flex;
		justify-content: flex-end;
		padding: 4px 8px;
		background: var(--surface-2, #1c1c24);
		border-top: 1px solid var(--line-hairline, #333);
	}
</style>
