<script lang="ts" generics="R extends string, S extends { role: R; unassigned?: boolean }">
	import { tick, untrack, type Snippet } from 'svelte';
	import { combineTargets, leafRects, type Rect } from '../pane-layout/combine.js';
	import { findNode, listLeaves, setSplitRatio, swapLeafIds } from '../pane-layout/tree.js';
	import type { LayoutNode, SplitDirection } from '../pane-layout/types.js';
	import AppWindowTree from './AppWindowTree.svelte';
	import {
		appWindowBodyId,
		createAppWindowLeafHome,
		layoutSlotKey,
		nextAppWindowLayoutId
	} from './leafHome.js';
	import {
		canCloseAppWindow,
		clampUnavailableRoles,
		closeAppWindow,
		combineAppWindow,
		isUnassignedWindow,
		setAppWindowRole,
		sliceAppWindow,
		sliceGuideFromPoint,
		splitAppWindow
	} from './manager.js';
	import { appWindowsOwnsShortcut } from './shortcutScope.js';
	import type { AppWindowRoleDef } from './types.js';

	let {
		root = $bindable(),
		windows = $bindable(),
		focusedId = $bindable(),
		editing = $bindable(false),
		slicing = $bindable(false),
		layoutId = 'app',
		testid = 'app-windows',
		testidPrefix = 'app-window',
		hostClass = '',
		roles,
		availableRoles,
		fallbackRole,
		inherit,
		onSelectRole,
		onFocus,
		onBeforeSplit,
		onAfterClose,
		pane,
		hosted,
		hostLeafId = null,
		extraEdit,
		extraFields,
		leafClass,
		leafProps,
		leafChrome
	}: {
		root: LayoutNode;
		windows: Record<string, S>;
		focusedId: string;
		editing?: boolean;
		slicing?: boolean;
		layoutId?: string;
		testid?: string;
		testidPrefix?: string;
		hostClass?: string;
		roles: readonly AppWindowRoleDef<R>[];
		availableRoles?: readonly R[];
		fallbackRole: R;
		inherit: (source: S | undefined, role: R) => S;
		/** Return false to skip the default role assignment (e.g. open a picker). */
		onSelectRole?: (leafId: string, role: R) => boolean | void;
		onFocus?: (leafId: string) => void;
		onBeforeSplit?: (leafId: string) => void;
		onAfterClose?: (closedId: string) => void;
		pane: Snippet<[{ id: string; role: R; focused: boolean }]>;
		hosted?: Snippet;
		hostLeafId?: string | null;
		extraEdit?: Snippet<[{ id: string; role: R }]>;
		extraFields?: Snippet<[{ id: string; role: R }]>;
		leafClass?: (id: string, role: R, focused: boolean) => string;
		leafProps?: (id: string, role: R) => Record<string, string>;
		leafChrome?: Snippet<[{ id: string; role: R; focused: boolean }]>;
	} = $props();

	// Slot/body ids are `aw-${layoutId}-slot-${leafId}`. Every DualPaneExplorer
	// used to pass layoutId="files" and start with leaf id "left", so a second
	// Files hub pane's getElementById rehomed its inner windows into the first.
	// svelte-ignore state_referenced_locally
	const instanceLayoutId = nextAppWindowLayoutId(layoutId);
	const home = createAppWindowLeafHome(instanceLayoutId);
	const leaves = $derived(listLeaves(root));
	const slotKey = $derived(layoutSlotKey(root));
	const available = $derived(new Set(availableRoles ?? roles.map((r) => r.id)));
	const pickerRoles = $derived(roles.filter((r) => available.has(r.id)));

	let parkEl: HTMLElement | null = $state(null);
	let liveHost: HTMLElement | null = $state(null);
	let hostEl: HTMLElement | null = $state(null);
	let sliceGuide = $state<{
		leafId: string;
		direction: SplitDirection;
		ratio: number;
		pos: number;
	} | null>(null);
	let combinePreview = $state<Rect | null>(null);
	const combineByLeaf = $derived.by(() => {
		const rects = leafRects(root);
		const map: Record<string, ReturnType<typeof combineTargets>> = {};
		for (const leaf of leaves) {
			map[leaf.id] = combineTargets(root, leaf.id, rects);
		}
		return map;
	});

	const TEXT_ENTRY_INPUT_TYPES = new Set([
		'text',
		'search',
		'url',
		'tel',
		'email',
		'password',
		'number',
		'date',
		'datetime-local',
		'month',
		'time',
		'week'
	]);

	function targetConsumesKey(target: HTMLElement | null, e: KeyboardEvent): boolean {
		if (!target) return false;
		if (target.tagName === 'TEXTAREA' || target.isContentEditable) return true;
		if (target.tagName !== 'INPUT') return false;
		const type = (target as HTMLInputElement).type;
		if (TEXT_ENTRY_INPUT_TYPES.has(type)) return true;
		if (type === 'range') {
			return (
				e.key.startsWith('Arrow') ||
				e.key === 'Home' ||
				e.key === 'End' ||
				e.key === 'PageUp' ||
				e.key === 'PageDown'
			);
		}
		if (type === 'checkbox' || type === 'radio') {
			return e.key === ' ' || e.key === 'Spacebar' || e.key.startsWith('Arrow');
		}
		return false;
	}

	function bodyEl(id: string): HTMLElement | null {
		return document.getElementById(appWindowBodyId(instanceLayoutId, id));
	}

	function parkAll() {
		home.parkLeaves(parkEl);
		if (parkEl && liveHost && liveHost.parentNode !== parkEl) parkEl.appendChild(liveHost);
	}

	function rehomeLive() {
		if (!liveHost || !hostLeafId) return;
		const body = bodyEl(hostLeafId);
		if (body && liveHost.parentNode !== body) body.appendChild(liveHost);
	}

	function registerLive(node: HTMLElement) {
		liveHost = node;
		rehomeLive();
		return {
			destroy() {
				if (liveHost === node) liveHost = null;
				node.remove();
			}
		};
	}

	$effect.pre(() => {
		void slotKey;
		untrack(() => parkAll());
	});
	$effect(() => {
		void slotKey;
		void hostLeafId;
		const ids = untrack(() => listLeaves(root).map((leaf) => leaf.id));
		let cancelled = false;
		void tick().then(() => {
			if (cancelled) return;
			home.rehomeLeaves(ids);
			rehomeLive();
		});
		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		const next = untrack(() =>
			clampUnavailableRoles(windows, available, fallbackRole, inherit)
		);
		if (next !== windows) windows = next;
	});

	function onResize(splitId: string, deltaRatio: number) {
		const split = findNode(root, splitId);
		if (!split || split.kind !== 'split') return;
		root = setSplitRatio(root, splitId, split.ratio + deltaRatio);
	}

	function focusLeaf(id: string) {
		focusedId = id;
		onFocus?.(id);
	}

	function exitSlice() {
		slicing = false;
		editing = false;
		sliceGuide = null;
	}

	function toggleSlice() {
		if (slicing) {
			exitSlice();
			return;
		}
		editing = false;
		slicing = true;
	}

	function toggleEdit() {
		slicing = false;
		sliceGuide = null;
		editing = !editing;
	}

	function splitAt(leafId: string, direction: SplitDirection) {
		onBeforeSplit?.(leafId);
		const next = splitAppWindow(
			root,
			windows,
			leafId,
			direction,
			roles,
			inherit,
			available
		);
		if (!next) return;
		root = next.root;
		windows = next.windows;
		focusedId = next.newId;
	}

	function sliceAt(leafId: string, direction: SplitDirection, ratio: number) {
		onBeforeSplit?.(leafId);
		const next = sliceAppWindow(
			root,
			windows,
			leafId,
			direction,
			ratio,
			roles,
			inherit,
			available
		);
		if (!next) return;
		root = next.root;
		windows = next.windows;
		focusedId = next.newId;
		sliceGuide = null;
	}

	function onSliceMove(leafId: string, e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		const rect = el.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;
		const { direction, ratio } = sliceGuideFromPoint(x, y, rect.width, rect.height);
		sliceGuide = {
			leafId,
			direction,
			ratio,
			pos: direction === 'row' ? x : y
		};
	}

	function onSliceLeave(leafId: string) {
		if (sliceGuide?.leafId === leafId) sliceGuide = null;
	}

	function onSlicePointer(leafId: string, e: PointerEvent) {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		const el = e.currentTarget as HTMLElement;
		const rect = el.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;
		const { direction, ratio } = sliceGuideFromPoint(x, y, rect.width, rect.height);
		sliceAt(leafId, direction, ratio);
	}

	$effect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (!appWindowsOwnsShortcut(hostEl, e.target)) return;
			const target = e.target as HTMLElement | null;
			if (targetConsumesKey(target, e)) return;
			if (e.ctrlKey || e.metaKey || e.altKey) return;
			const key = e.key.toLowerCase();
			if (key === 's' && e.shiftKey) {
				e.preventDefault();
				e.stopPropagation();
				toggleSlice();
				return;
			}
			if (key === 'w' && e.shiftKey) {
				e.preventDefault();
				e.stopPropagation();
				toggleEdit();
				return;
			}
			if (slicing && key === 'escape') {
				e.preventDefault();
				e.stopPropagation();
				exitSlice();
			}
		};
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	});

	function combineAt(fromId: string, towardId: string) {
		const next = combineAppWindow(root, windows, fromId, towardId, roles, inherit);
		if (!next) return;
		root = next.root;
		windows = next.windows;
		combinePreview = null;
		if (!windows[focusedId]) {
			focusedId = listLeaves(root)[0]?.id ?? focusedId;
		}
		for (const id of next.removed) onAfterClose?.(id);
	}

	function swapAt(fromId: string, towardId: string) {
		if (fromId === towardId) return;
		root = swapLeafIds(root, fromId, towardId);
		combinePreview = null;
	}

	function closeAt(leafId: string) {
		const next = closeAppWindow(root, windows, leafId, roles);
		if (!next) return;
		root = next.root;
		windows = next.windows;
		if (focusedId === leafId || !windows[focusedId]) {
			focusedId = listLeaves(root)[0]?.id ?? focusedId;
		}
		onAfterClose?.(leafId);
	}

	function setRole(leafId: string, role: R) {
		if (onSelectRole && onSelectRole(leafId, role) === false) {
			const current = windows[leafId];
			if (current?.unassigned && current.role === role) {
				windows = { ...windows, [leafId]: { ...current, unassigned: false } };
			}
			focusLeaf(leafId);
			return;
		}
		const next = setAppWindowRole(windows, leafId, role, roles, inherit);
		if (!next) return;
		windows = next;
		focusLeaf(leafId);
	}

	function roleOf(id: string): R {
		return windows[id]?.role ?? fallbackRole;
	}

	function canClose(id: string): boolean {
		return canCloseAppWindow(root, windows, id, roles);
	}
</script>

<div
	class="aw-host {hostClass}"
	class:editing
	class:slicing
	data-testid={testid}
	bind:this={hostEl}
>
	<div class="aw-root">
		<AppWindowTree node={root} layoutId={instanceLayoutId} {testidPrefix} {onResize} />
	</div>
	{#if editing && combinePreview}
		<div
			class="aw-combine-preview"
			data-testid="{testidPrefix}-combine-preview"
			style="left: {combinePreview.x * 100}%; top: {combinePreview.y * 100}%; width: {combinePreview.w * 100}%; height: {combinePreview.h * 100}%;"
		></div>
	{/if}
	<div class="aw-park" bind:this={parkEl} hidden aria-hidden="true">
		{#if hosted}
			<!-- The single live well, parked here and relocated into whichever leaf
			     is the host. Consumers assert on it to prove the live view follows
			     the target pane, so it carries a testid like every other leaf. -->
			<div class="aw-live-host" data-testid="{testidPrefix}-live" use:registerLive>
				{@render hosted()}
			</div>
		{/if}
		{#each leaves as leaf (leaf.id)}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div
				class="aw-leaf {leafClass?.(leaf.id, roleOf(leaf.id), focusedId === leaf.id) ?? ''}"
				class:focused={focusedId === leaf.id}
				data-testid="{testidPrefix}-leaf"
				data-aw-id={leaf.id}
				data-aw-role={roleOf(leaf.id)}
				data-aw-focused={focusedId === leaf.id ? 'true' : 'false'}
				{...leafProps?.(leaf.id, roleOf(leaf.id)) ?? {}}
				onclick={() => focusLeaf(leaf.id)}
				onpointerdown={() => focusLeaf(leaf.id)}
				use:home.homeLeaf={leaf.id}
			>
				<div class="aw-body" id={appWindowBodyId(instanceLayoutId, leaf.id)}>
					{#if !isUnassignedWindow(windows[leaf.id])}
						{@render pane({ id: leaf.id, role: roleOf(leaf.id), focused: focusedId === leaf.id })}
					{/if}
				</div>
				{#if leafChrome && !slicing}
					{@render leafChrome({ id: leaf.id, role: roleOf(leaf.id), focused: focusedId === leaf.id })}
				{/if}
				{#if slicing}
					<button
						type="button"
						class="aw-slice-bin"
						data-testid="{testidPrefix}-slice-close"
						title={canClose(leaf.id) ? 'Remove window' : 'Last required window stays open'}
						aria-label="Close window"
						disabled={!canClose(leaf.id)}
						onclick={(e) => {
							e.stopPropagation();
							closeAt(leaf.id);
						}}
						onpointerdown={(e) => e.stopPropagation()}
					>
						<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
					</button>
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<div
						class="aw-slice-layer"
						class:row-cut={sliceGuide?.leafId === leaf.id && sliceGuide.direction === 'row'}
						class:col-cut={sliceGuide?.leafId === leaf.id && sliceGuide.direction === 'col'}
						data-testid="{testidPrefix}-slice-layer"
						onpointermove={(e) => onSliceMove(leaf.id, e)}
						onpointerdown={(e) => onSlicePointer(leaf.id, e)}
						onpointerleave={() => onSliceLeave(leaf.id)}
					>
						{#if sliceGuide && sliceGuide.leafId === leaf.id}
							<div
								class="aw-slice-guide"
								class:row={sliceGuide.direction === 'row'}
								class:col={sliceGuide.direction === 'col'}
								data-testid="{testidPrefix}-slice-guide"
								data-aw-direction={sliceGuide.direction}
								style={sliceGuide.direction === 'row'
									? `left: ${sliceGuide.pos}px`
									: `top: ${sliceGuide.pos}px`}
							></div>
						{/if}
					</div>
				{:else if !editing && isUnassignedWindow(windows[leaf.id])}
					<div class="aw-picker" data-testid="{testidPrefix}-role-picker">
						<p class="aw-picker-label">Window</p>
						<div class="aw-picker-list">
							{#each pickerRoles as role}
								<button
									type="button"
									data-testid="{testidPrefix}-role-pick"
									data-aw-role={role.id}
									onclick={(e) => {
										e.stopPropagation();
										setRole(leaf.id, role.id);
									}}
								>
									{role.label}
								</button>
							{/each}
						</div>
					</div>
				{/if}
				{#if editing}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<div
						class="aw-edit"
						data-testid="{testidPrefix}-edit"
						onclick={(e) => e.stopPropagation()}
						onpointerdown={(e) => e.stopPropagation()}
					>
						<div class="aw-edit-card">
							<div class="aw-actions aw-window-ops">
								<button
									type="button"
									data-testid="{testidPrefix}-split-row"
									title="Split right"
									aria-label="Split right"
									onclick={(e) => {
										e.stopPropagation();
										splitAt(leaf.id, 'row');
									}}
								>
									<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/></svg>
								</button>
								<button
									type="button"
									data-testid="{testidPrefix}-split-col"
									title="Split down"
									aria-label="Split down"
									onclick={(e) => {
										e.stopPropagation();
										splitAt(leaf.id, 'col');
									}}
								>
									<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 12h18"/></svg>
								</button>
								<button
									type="button"
									data-testid="{testidPrefix}-close"
									title={canClose(leaf.id) ? 'Remove window' : 'Last required window stays open'}
									aria-label="Close window"
									disabled={!canClose(leaf.id)}
									onclick={(e) => {
										e.stopPropagation();
										closeAt(leaf.id);
									}}
								>
									<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
								</button>
							</div>
							<label class="aw-role">
								<span class="aw-role-label">Window</span>
								<select
									aria-label="Window type"
									data-testid="{testidPrefix}-role"
									value={roleOf(leaf.id)}
									onchange={(e) =>
										setRole(leaf.id, (e.currentTarget as HTMLSelectElement).value as R)}
								>
									{#each pickerRoles as role}
										<option value={role.id}>{role.label}</option>
									{/each}
								</select>
							</label>
							{#if extraFields}
								{@render extraFields({ id: leaf.id, role: roleOf(leaf.id) })}
							{/if}
							{#if extraEdit}
								<div class="aw-actions aw-extra">
									{@render extraEdit({ id: leaf.id, role: roleOf(leaf.id) })}
								</div>
							{/if}
							<button
								type="button"
								class="aw-done"
								data-testid="{testidPrefix}-done"
								title="Keep this layout"
								aria-label="Use this layout"
								onclick={(e) => {
									e.stopPropagation();
									editing = false;
									combinePreview = null;
								}}
							>
								Use this layout
							</button>
						</div>
					</div>
					{#each combineByLeaf[leaf.id] ?? [] as target (target.side)}
						<button
							type="button"
							class="aw-combine {target.side}"
							data-testid="{testidPrefix}-combine-{target.side}"
							data-aw-combine={target.side}
							title="Combine with window to the {target.side}"
							aria-label="Combine with window to the {target.side}"
							disabled={target.removes && !canClose(target.towardId)}
							onpointerenter={() => {
								combinePreview = target.result;
							}}
							onpointerleave={() => {
								combinePreview = null;
							}}
							onclick={(e) => {
								e.stopPropagation();
								combineAt(leaf.id, target.towardId);
							}}
							onpointerdown={(e) => e.stopPropagation()}
						>
							{#if target.side === 'left'}
								<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
							{:else if target.side === 'right'}
								<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
							{:else if target.side === 'top'}
								<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>
							{:else}
								<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
							{/if}
						</button>
						<button
							type="button"
							class="aw-swap {target.side}"
							data-testid="{testidPrefix}-swap-{target.side}"
							data-aw-swap={target.side}
							title="Swap with window to the {target.side}"
							aria-label="Swap with window to the {target.side}"
							onclick={(e) => {
								e.stopPropagation();
								swapAt(leaf.id, target.towardId);
							}}
							onpointerdown={(e) => e.stopPropagation()}
						>
							{#if target.side === 'left' || target.side === 'right'}
								<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7 4 12l4 5"/><path d="M4 12h16"/><path d="m16 7 4 5-4 5"/></svg>
							{:else}
								<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 8 12 4 7 8"/><path d="M12 4v16"/><path d="m7 16 5 4 5-4"/></svg>
							{/if}
						</button>
					{/each}
				{/if}
			</div>
		{/each}
	</div>
</div>

<style>
	.aw-host,
	.aw-root {
		display: flex;
		flex: 1 1 0;
		min-width: 0;
		min-height: 0;
		width: 100%;
		height: 100%;
		position: relative;
	}
	.aw-leaf {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		flex: 1 1 0;
		height: 100%;
		width: 100%;
		position: relative;
		overflow: hidden;
		background: var(--surface-ground);
	}
	.aw-body {
		flex: 1 1 0;
		min-width: 0;
		min-height: 0;
		display: flex;
		overflow: hidden;
		/* FileExplorer header is z-index 9; without a stacking context here
		   that value competes with .aw-edit (6) and the toolbar paints through
		   the windows overlay. */
		isolation: isolate;
	}
	.aw-body > :global(*),
	.aw-live-host {
		flex: 1 1 0;
		min-width: 0;
		min-height: 0;
		display: flex;
		width: 100%;
		height: 100%;
	}
	.aw-edit {
		position: absolute;
		inset: 0;
		z-index: 6;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 12px;
		background: color-mix(in srgb, rgb(var(--scrim-rgb, 0 0 0) / 0.55) 70%, #1a1a1e);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
	}
	.aw-edit-card {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 10px;
		min-width: 12rem;
		max-width: min(22rem, 100%);
		padding: 12px 14px;
		background: rgb(var(--bg-rgb, 16 16 20) / 0.88);
		border: 1px solid rgb(var(--border-rgb, 90 90 96) / 0.75);
		border-radius: var(--radius-md, 8px);
		box-shadow: 0 10px 28px rgb(var(--scrim-rgb, 0 0 0) / 0.4);
		color: var(--text-primary);
	}
	.aw-role {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 10rem;
		color: var(--text-primary);
		font-size: var(--text-sm);
	}
	.aw-role-label {
		font-size: var(--text-xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.aw-role select {
		height: 32px;
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-md);
		background: var(--surface-2);
		color: var(--text-primary);
		padding: 0 8px;
	}
	.aw-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 6px;
	}
	.aw-actions :global(button) {
		min-width: 36px;
		height: 36px;
		padding: 0 10px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-md);
		background: var(--surface-2);
		color: var(--text-primary);
		cursor: pointer;
		font-size: var(--text-xs);
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.aw-actions :global(button:hover:not(:disabled)),
	.aw-actions :global(button:focus-visible:not(:disabled)) {
		border-color: var(--accent);
		background: var(--accent-glow);
		color: var(--accent);
	}
	.aw-actions :global(button:disabled) {
		opacity: 0.35;
		cursor: not-allowed;
	}
	.aw-window-ops {
		justify-content: center;
	}
	.aw-extra {
		flex-direction: column;
	}
	.aw-done {
		width: 100%;
		height: 34px;
		margin-top: 2px;
		border: 1px solid var(--accent, #6ea8fe);
		border-radius: var(--radius-md, 8px);
		background: rgb(var(--accent-rgb, 110 168 254) / 0.18);
		color: var(--accent, #6ea8fe);
		cursor: pointer;
		font-size: var(--text-xs, 12px);
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.aw-done:hover,
	.aw-done:focus-visible {
		background: rgb(var(--accent-rgb, 110 168 254) / 0.3);
	}
	.aw-combine-preview {
		position: absolute;
		z-index: 9;
		pointer-events: none;
		background: rgb(var(--accent-rgb, 110 168 254) / 0.28);
		border: 2px solid var(--accent, #6ea8fe);
		box-sizing: border-box;
	}
	.aw-combine {
		position: absolute;
		z-index: 8;
		width: 26px;
		height: 26px;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid rgb(var(--border-rgb, 90 90 96) / 0.8);
		border-radius: var(--radius-md, 8px);
		background: rgb(var(--bg-rgb, 16 16 20) / 0.95);
		color: var(--text-primary);
		cursor: pointer;
	}
	.aw-combine.right {
		top: 50%;
		right: 0;
		transform: translateY(-50%);
	}
	.aw-combine.left {
		top: 50%;
		left: 0;
		transform: translateY(-50%);
	}
	.aw-combine.top {
		left: 50%;
		top: 0;
		transform: translateX(-50%);
	}
	.aw-combine.bottom {
		left: 50%;
		bottom: 0;
		transform: translateX(-50%);
	}
	.aw-combine:hover:not(:disabled),
	.aw-combine:focus-visible:not(:disabled) {
		border-color: var(--accent, #6ea8fe);
		color: var(--accent, #6ea8fe);
		background: rgb(var(--accent-rgb, 110 168 254) / 0.2);
	}
	.aw-combine:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}
	.aw-swap {
		position: absolute;
		z-index: 8;
		width: 26px;
		height: 26px;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid rgb(var(--border-rgb, 90 90 96) / 0.8);
		border-radius: var(--radius-md, 8px);
		background: rgb(var(--bg-rgb, 16 16 20) / 0.95);
		color: var(--text-primary);
		cursor: pointer;
	}
	.aw-swap.right {
		top: 50%;
		right: 32px;
		transform: translateY(-50%);
	}
	.aw-swap.left {
		top: 50%;
		left: 32px;
		transform: translateY(-50%);
	}
	.aw-swap.top {
		left: 50%;
		top: 32px;
		transform: translateX(-50%);
	}
	.aw-swap.bottom {
		left: 50%;
		bottom: 32px;
		transform: translateX(-50%);
	}
	.aw-swap:hover,
	.aw-swap:focus-visible {
		border-color: var(--accent, #6ea8fe);
		color: var(--accent, #6ea8fe);
		background: rgb(var(--accent-rgb, 110 168 254) / 0.2);
	}
	.aw-slice-layer {
		position: absolute;
		inset: 0;
		z-index: 7;
		cursor: crosshair;
	}
	.aw-slice-layer.row-cut {
		cursor: col-resize;
	}
	.aw-slice-layer.col-cut {
		cursor: row-resize;
	}
	.aw-slice-guide {
		position: absolute;
		background: #e11d2e;
		pointer-events: none;
		z-index: 1;
	}
	.aw-slice-guide.row {
		top: 0;
		width: 2px;
		height: 100%;
		transform: translateX(-1px);
	}
	.aw-slice-guide.col {
		left: 0;
		height: 2px;
		width: 100%;
		transform: translateY(-1px);
	}
	.aw-slice-bin {
		position: absolute;
		top: 8px;
		right: 8px;
		z-index: 8;
		width: 28px;
		height: 28px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid rgb(var(--border-rgb, 90 90 96) / 0.75);
		border-radius: var(--radius-md, 8px);
		background: rgb(var(--bg-rgb, 16 16 20) / 0.88);
		color: var(--text-primary);
		cursor: pointer;
	}
	.aw-slice-bin:hover:not(:disabled),
	.aw-slice-bin:focus-visible:not(:disabled) {
		border-color: var(--accent);
		color: var(--accent);
	}
	.aw-slice-bin:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}
	.aw-picker {
		position: absolute;
		inset: 0;
		z-index: 5;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 16px;
		background: var(--surface-ground, var(--bg-chrome));
	}
	.aw-picker-label {
		margin: 0;
		font-size: var(--text-xs, 12px);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.aw-picker-list {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 6px;
		min-width: 10rem;
		max-width: min(18rem, 100%);
	}
	.aw-picker-list button {
		height: 34px;
		padding: 0 12px;
		border: 1px solid var(--line-strong, rgb(var(--border-rgb, 90 90 96) / 0.75));
		border-radius: var(--radius-md, 8px);
		background: var(--surface-2, rgb(var(--bg-rgb, 16 16 20) / 0.88));
		color: var(--text-primary);
		cursor: pointer;
		font-size: var(--text-sm, 13px);
	}
	.aw-picker-list button:hover,
	.aw-picker-list button:focus-visible {
		border-color: var(--accent);
		background: var(--accent-glow, rgb(var(--accent-rgb, 110 168 254) / 0.18));
		color: var(--accent);
	}
</style>
