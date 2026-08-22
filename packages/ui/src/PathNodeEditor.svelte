<!--
	Standalone node/control-handle overlay. Mount inside the parent <svg>
	(typically viewBox 0 0 W H). Renders a <g>, not a nested <svg>.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		createParsedPathEntries,
		findCoincidentNodesInParsedPaths,
		updateCoincidentParsedNodes,
		clientPointToOwnerSvg,
		type NodeRef,
		type PathData
	} from '@shared-packages/drawing-tools';

	let {
		paths,
		zoom = 1,
		showHandles = true,
		disabled = false,
		onPathsChange,
		onDragStart,
		onDragEnd
	}: {
		paths: PathData[];
		zoom?: number;
		showHandles?: boolean;
		disabled?: boolean;
		onPathsChange?: (paths: PathData[]) => void;
		onDragStart?: () => void;
		onDragEnd?: () => void;
	} = $props();

	const COINCIDENT_EPS = 0.5; // canvas units; SVGRenderer output is typically integer-ish

	let rootEl: SVGGElement | null = $state(null);
	let drag: {
		pointerId: number;
		primary: NodeRef;
		linked: NodeRef[];
		target: Element | null;
		coordEl: SVGElement | null;
	} | null = $state(null);

	let parsedPathEntries = $derived(showHandles ? createParsedPathEntries(paths) : []);

	function nodeHandleKey(path: PathData | undefined, index: number) {
		if (!path) return `missing-node:${index}`;
		return `${path.layerId || 'default'}:${path.bakeGroupId || ''}:${index}`;
	}

	function attachDragListeners() {
		window.addEventListener('pointermove', onWindowPointerMove);
		window.addEventListener('pointerup', onWindowPointerUp);
		window.addEventListener('pointercancel', onWindowPointerUp);
	}

	function detachDragListeners() {
		window.removeEventListener('pointermove', onWindowPointerMove);
		window.removeEventListener('pointerup', onWindowPointerUp);
		window.removeEventListener('pointercancel', onWindowPointerUp);
	}

	function endDrag() {
		if (!drag) return;
		const { pointerId, target } = drag;
		drag = null;
		detachDragListeners();
		if (target) {
			try {
				target.releasePointerCapture(pointerId);
			} catch {
				/* already released */
			}
		}
		onDragEnd?.();
	}

	function applyDrag(clientX: number, clientY: number) {
		if (!drag || disabled || !showHandles) return;
		const { x, y } = clientPointToOwnerSvg(drag.coordEl, clientX, clientY);
		const next = paths.map((p) => ({ ...p }));
		const entries = createParsedPathEntries(next);
		updateCoincidentParsedNodes(next, entries, drag.linked, x, y);
		onPathsChange?.(next);
	}

	function onWindowPointerMove(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.pointerId) return;
		applyDrag(e.clientX, e.clientY);
	}

	function onWindowPointerUp(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.pointerId) return;
		endDrag();
	}

	function handleNodePointerDown(
		e: PointerEvent,
		pathIndex: number,
		cmdIndex: number,
		argOffset: number
	) {
		if (disabled || drag || e.button !== 0) return;
		e.stopPropagation();
		e.preventDefault();

		const primary: NodeRef = { pathIndex, cmdIndex, argOffset };
		const linked = findCoincidentNodesInParsedPaths(
			parsedPathEntries,
			pathIndex,
			cmdIndex,
			argOffset,
			COINCIDENT_EPS
		);

		drag = {
			pointerId: e.pointerId,
			primary,
			linked,
			target: e.currentTarget as Element,
			coordEl: rootEl
		};
		onDragStart?.();
		try {
			(e.currentTarget as Element)?.setPointerCapture(e.pointerId);
		} catch {
			/* capture not available; window listeners still track the drag */
		}
		attachDragListeners();
	}

	onDestroy(() => {
		detachDragListeners();
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
{#if showHandles}
	<g
		bind:this={rootEl}
		class="path-node-editor"
		class:disabled
		style="touch-action: none;"
	>
		{#each parsedPathEntries as entry (nodeHandleKey(entry.path, entry.pathIndex))}
			<g transform={entry.path.transform || ''}>
				{#each entry.commands as cmd, cmdIndex}
					{#if cmd.type.toUpperCase() === 'M' || cmd.type.toUpperCase() === 'L'}
						<circle
							cx={cmd.args[0]}
							cy={cmd.args[1]}
							r={4 / zoom}
							fill="var(--accent, #38bdf8)"
							stroke="white"
							stroke-width={2 / zoom}
							class="node-handle"
							onpointerdown={(e) => handleNodePointerDown(e, entry.pathIndex, cmdIndex, 0)}
						/>
					{:else if cmd.type.toUpperCase() === 'C'}
						<!-- Curve points -->
						<circle
							cx={cmd.args[4]}
							cy={cmd.args[5]}
							r={4 / zoom}
							fill="var(--accent, #38bdf8)"
							stroke="white"
							stroke-width={2 / zoom}
							class="node-handle"
							onpointerdown={(e) => handleNodePointerDown(e, entry.pathIndex, cmdIndex, 4)}
						/>
						<circle
							cx={cmd.args[0]}
							cy={cmd.args[1]}
							r={3 / zoom}
							fill="var(--success, #22c55e)"
							stroke="white"
							stroke-width={1.5 / zoom}
							class="node-handle control-handle"
							onpointerdown={(e) => handleNodePointerDown(e, entry.pathIndex, cmdIndex, 0)}
						/>
						<circle
							cx={cmd.args[2]}
							cy={cmd.args[3]}
							r={3 / zoom}
							fill="var(--success, #22c55e)"
							stroke="white"
							stroke-width={1.5 / zoom}
							class="node-handle control-handle"
							onpointerdown={(e) => handleNodePointerDown(e, entry.pathIndex, cmdIndex, 2)}
						/>
						<!-- Lines to control points -->
						{#if cmdIndex > 0}
							<line
								x1={entry.commands[cmdIndex - 1].args[entry.commands[cmdIndex - 1].args.length - 2]}
								y1={entry.commands[cmdIndex - 1].args[entry.commands[cmdIndex - 1].args.length - 1]}
								x2={cmd.args[0]}
								y2={cmd.args[1]}
								stroke="var(--success, #22c55e)"
								stroke-width={1 / zoom}
								stroke-dasharray="2,2"
								pointer-events="none"
							/>
						{/if}
						<line
							x1={cmd.args[4]}
							y1={cmd.args[5]}
							x2={cmd.args[2]}
							y2={cmd.args[3]}
							stroke="var(--success, #22c55e)"
							stroke-width={1 / zoom}
							stroke-dasharray="2,2"
							pointer-events="none"
						/>
					{:else if cmd.type.toUpperCase() === 'Q'}
						<circle
							cx={cmd.args[2]}
							cy={cmd.args[3]}
							r={4 / zoom}
							fill="var(--accent, #38bdf8)"
							stroke="white"
							stroke-width={2 / zoom}
							class="node-handle"
							onpointerdown={(e) => handleNodePointerDown(e, entry.pathIndex, cmdIndex, 2)}
						/>
						<circle
							cx={cmd.args[0]}
							cy={cmd.args[1]}
							r={3 / zoom}
							fill="var(--success, #22c55e)"
							stroke="white"
							stroke-width={1.5 / zoom}
							class="node-handle control-handle"
							onpointerdown={(e) => handleNodePointerDown(e, entry.pathIndex, cmdIndex, 0)}
						/>
					{/if}
				{/each}
			</g>
		{/each}
	</g>
{/if}

<style>
	.node-handle {
		cursor: grab;
		touch-action: none;
	}
	.path-node-editor.disabled .node-handle {
		pointer-events: none;
		cursor: default;
	}
</style>
