<script lang="ts" generics="R extends string, S extends { role: R }">
	import { tick, untrack, type Snippet } from 'svelte';
	import { findNode, listLeaves, setSplitRatio } from '../pane-layout/tree.js';
	import type { LayoutNode, SplitDirection } from '../pane-layout/types.js';
	import AppWindowTree from './AppWindowTree.svelte';
	import {
		appWindowBodyId,
		createAppWindowLeafHome,
		layoutSlotKey
	} from './leafHome.js';
	import {
		canCloseAppWindow,
		clampUnavailableRoles,
		closeAppWindow,
		setAppWindowRole,
		splitAppWindow
	} from './manager.js';
	import type { AppWindowRoleDef } from './types.js';

	let {
		root = $bindable(),
		windows = $bindable(),
		focusedId = $bindable(),
		editing = $bindable(false),
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

	const home = createAppWindowLeafHome(layoutId);
	const leaves = $derived(listLeaves(root));
	const slotKey = $derived(layoutSlotKey(root));
	const available = $derived(new Set(availableRoles ?? roles.map((r) => r.id)));
	const pickerRoles = $derived(roles.filter((r) => available.has(r.id)));

	let parkEl: HTMLElement | null = $state(null);
	let liveHost: HTMLElement | null = $state(null);

	function bodyEl(id: string): HTMLElement | null {
		return document.getElementById(appWindowBodyId(layoutId, id));
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
		if (onSelectRole && onSelectRole(leafId, role) === false) return;
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

<div class="aw-host {hostClass}" class:editing data-testid={testid}>
	<div class="aw-root">
		<AppWindowTree node={root} {layoutId} {testidPrefix} {onResize} />
	</div>
	<div class="aw-park" bind:this={parkEl} hidden aria-hidden="true">
		{#if hosted}
			<div class="aw-live-host" use:registerLive>
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
				<div class="aw-body" id={appWindowBodyId(layoutId, leaf.id)}>
					{@render pane({ id: leaf.id, role: roleOf(leaf.id), focused: focusedId === leaf.id })}
				</div>
				{#if leafChrome}
					{@render leafChrome({ id: leaf.id, role: roleOf(leaf.id), focused: focusedId === leaf.id })}
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
						<div class="aw-actions">
							{#if extraEdit}
								{@render extraEdit({ id: leaf.id, role: roleOf(leaf.id) })}
							{/if}
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
								title={canClose(leaf.id) ? 'Close window' : 'Last required window stays open'}
								aria-label="Close window"
								disabled={!canClose(leaf.id)}
								onclick={(e) => {
									e.stopPropagation();
									closeAt(leaf.id);
								}}
							>
								<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
							</button>
						</div>
					</div>
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
		gap: 12px;
		padding: 12px;
		background: rgb(var(--scrim-rgb) / 0.45);
		backdrop-filter: blur(2px);
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
</style>
