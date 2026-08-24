<script lang="ts">
	import {
		RESIZE_HANDLES,
		RESIZE_HANDLE_CURSORS,
		RESIZE_HANDLE_LABELS,
		showMoveHit,
		showResizeHandles,
		showRotateHandle,
		type ResizeHandle,
		type TransformMode
	} from './objectTransform.ts';

	let {
		mode,
		allowMove = true,
		onMoveStart,
		onResizeStart,
		onRotateStart,
		onResizeKeydown,
		onRotateKeydown
	}: {
		mode: TransformMode;
		allowMove?: boolean;
		onMoveStart?: (e: PointerEvent) => void;
		onResizeStart?: (e: PointerEvent, handle: ResizeHandle) => void;
		onRotateStart?: (e: PointerEvent) => void;
		onResizeKeydown?: (e: KeyboardEvent, handle: ResizeHandle) => void;
		onRotateKeydown?: (e: KeyboardEvent) => void;
	} = $props();
</script>

<div class="object-transform-frame" data-testid="object-transform-frame">
	{#if showMoveHit(mode, allowMove)}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="move-hit"
			data-testid="object-move-hit"
			style="cursor: move; touch-action: none;"
			onpointerdown={(e) => onMoveStart?.(e)}
			role="none"
		></div>
	{/if}

	{#if showRotateHandle(mode)}
		<div class="rotate-stem" aria-hidden="true"></div>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="rotate-handle"
			data-testid="object-rotate-handle"
			role="button"
			tabindex="0"
			aria-label="Rotate"
			title="Rotate"
			style="cursor: grab; touch-action: none;"
			onpointerdown={(e) => onRotateStart?.(e)}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
				onRotateKeydown?.(e);
			}}
		></div>
	{/if}

	{#if showResizeHandles(mode)}
		{#each RESIZE_HANDLES as handle (handle)}
			<div
				class="resize-handle {handle}"
				role="button"
				tabindex="0"
				aria-label={RESIZE_HANDLE_LABELS[handle]}
				data-testid="object-scale-handle"
				data-handle={handle}
				style="cursor: {RESIZE_HANDLE_CURSORS[handle]}; touch-action: none;"
				onpointerdown={(e) => onResizeStart?.(e, handle)}
				onkeydown={(e) => onResizeKeydown?.(e, handle)}
			></div>
		{/each}
	{/if}
</div>

<style>
	.object-transform-frame {
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: var(--z-handle, 2);
	}

	.move-hit {
		position: absolute;
		inset: 0;
		pointer-events: all;
	}

	.rotate-stem {
		position: absolute;
		left: 50%;
		top: -28px;
		width: 1px;
		height: 28px;
		background: var(--accent);
		transform: translateX(-50%);
		pointer-events: none;
	}

	.rotate-handle {
		position: absolute;
		left: 50%;
		top: -36px;
		width: 14px;
		height: 14px;
		margin-left: -7px;
		background: var(--bg-primary);
		border: 2px solid var(--accent);
		border-radius: 50%;
		pointer-events: all;
		box-shadow: 0 2px 4px var(--shadow-medium);
		z-index: var(--z-handle-control, 3);
	}

	.resize-handle {
		position: absolute;
		width: 10px;
		height: 10px;
		background: var(--bg-primary);
		border: 2px solid var(--accent);
		border-radius: 50%;
		pointer-events: all;
		box-shadow: 0 2px 4px var(--shadow-medium);
		z-index: var(--z-handle, 2);
	}

	.resize-handle.nw {
		top: -5px;
		left: -5px;
	}
	.resize-handle.n {
		top: -5px;
		left: calc(50% - 5px);
	}
	.resize-handle.ne {
		top: -5px;
		right: -5px;
	}
	.resize-handle.e {
		top: calc(50% - 5px);
		right: -5px;
	}
	.resize-handle.se {
		bottom: -5px;
		right: -5px;
	}
	.resize-handle.s {
		bottom: -5px;
		left: calc(50% - 5px);
	}
	.resize-handle.sw {
		bottom: -5px;
		left: -5px;
	}
	.resize-handle.w {
		top: calc(50% - 5px);
		left: -5px;
	}
</style>
