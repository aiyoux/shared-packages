<script lang="ts">
	/**
	 * Folder-tree navigation sidebar for FileExplorer's optional tree dock
	 * (left pane / top pane, like a classic file manager's folder tree).
	 *
	 * Lazily lists folder children per node (driver.list, folders only),
	 * caches them locally, and auto-reveals + expands the ancestor chain of
	 * `activeId` (the folder currently open in the main list) so the tree
	 * stays in sync with navigation there.
	 *
	 * Effects here only ever depend on the `driver` / `activeId` /
	 * `treeVersion` props — never on the local `children` / `expanded` /
	 * `loading` state they update. Reading that local state from inside an
	 * effect (even transitively through a helper) would make the effect
	 * depend on it, and the async loads below would then re-trigger the
	 * very effect that kicked them off. See FeThumbnail/FeFloatingPreview
	 * for the bug this pattern previously caused with blob URLs.
	 */
	import { untrack } from 'svelte';
	import FeIcon from './FeIcon.svelte';
	import type { ExplorerDriver, ExplorerEntry, ExplorerEntryId } from './explorerDriver.js';

	let {
		driver,
		activeId,
		treeVersion = 0,
		onNavigate,
		includeFiles = false,
		rootLabel = 'Root',
		showRoot = true,
		onSelect
	}: {
		driver: ExplorerDriver;
		activeId: ExplorerEntryId | null;
		treeVersion?: number;
		onNavigate: (id: ExplorerEntryId | null) => void;
		/** When true, list files as well as folders. FileExplorer dock stays folders-only. */
		includeFiles?: boolean;
		rootLabel?: string;
		showRoot?: boolean;
		/** File row click when includeFiles. Folders still use onNavigate. */
		onSelect?: (entry: ExplorerEntry) => void;
	} = $props();

	const ROOT_KEY = '__root__';

	let children = $state<Map<string, ExplorerEntry[]>>(new Map());
	let expanded = $state<Set<string>>(new Set());
	let loading = $state<Set<string>>(new Set());

	function keyFor(parentId: ExplorerEntryId | null): string {
		return parentId ?? ROOT_KEY;
	}

	async function loadChildren(
		d: ExplorerDriver,
		parentId: ExplorerEntryId | null,
		force = false
	): Promise<void> {
		const key = keyFor(parentId);
		if (!force && (children.has(key) || loading.has(key))) return;
		loading = new Set(loading).add(key);
		try {
			const { entries } = await d.list({ parentId });
			const rows = entries
				.filter((e) => includeFiles || e.kind === 'folder')
				.sort((a, b) => {
					if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
					return a.name.localeCompare(b.name);
				});
			children = new Map(children).set(key, rows);
		} catch {
			// Best-effort nav aid — leave the node collapsed-looking (no cached
			// children) rather than surfacing a separate error UI here.
		} finally {
			const next = new Set(loading);
			next.delete(key);
			loading = next;
		}
	}

	async function revealPath(d: ExplorerDriver, id: ExplorerEntryId | null): Promise<void> {
		if (!id) return;
		try {
			const chain = await d.getPath(id); // root..id, inclusive of id itself
			// Only ADD to `expanded` — never remove. The user may have
			// collapsed a node while getPath / loadChildren were in flight;
			// overwriting `expanded` with a stale snapshot would undo that
			// collapse. Re-read the live set right before assigning.
			const toAdd: ExplorerEntryId[] = [];
			for (const node of chain) {
				if (!expanded.has(node.id)) toAdd.push(node.id);
				await loadChildren(d, node.id);
			}
			if (toAdd.length > 0) {
				const next = new Set(expanded);
				for (const nid of toAdd) next.add(nid);
				expanded = next;
			}
		} catch {
			/* best-effort nav aid; ignore */
		}
	}

	async function refreshVisible(d: ExplorerDriver): Promise<void> {
		await loadChildren(d, null, true);
		for (const id of expanded) {
			await loadChildren(d, id, true);
		}
	}

	function toggleExpand(id: ExplorerEntryId): void {
		const next = new Set(expanded);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
			void loadChildren(driver, id);
		}
		expanded = next;
	}

	// Driver swap (e.g. switching connections): old ids don't exist under
	// the new driver, so reset everything and reload the root.
	$effect(() => {
		const d = driver;
		untrack(() => {
			children = new Map();
			expanded = new Set();
			loading = new Set();
			void loadChildren(d, null);
		});
	});

	// Navigation elsewhere (breadcrumbs, double-click, ...) should reveal
	// and expand the active folder's ancestor chain, like a real file
	// manager's tree does.
	$effect(() => {
		const id = activeId;
		const d = driver;
		untrack(() => {
			void revealPath(d, id);
		});
	});

	// Any mutation that can change folder structure (mkdir/rename/move/
	// delete/restore, or a live remote change) bumps `treeVersion` in
	// FileExplorer; re-fetch what's currently visible so the tree doesn't
	// go stale.
	$effect(() => {
		const v = treeVersion;
		const files = includeFiles;
		const d = driver;
		untrack(() => {
			void v;
			void files;
			void refreshVisible(d);
		});
	});

	// Standalone live refresh: subscribe root + expanded folders on the
	// same driver watch stream FileExplorer already uses (no second client).
	$effect(() => {
		const d = driver;
		const expandedIds = expanded;
		const unsubs: Array<() => void> = [];
		untrack(() => {
			if (!d.subscribeChanges) return;
			unsubs.push(d.subscribeChanges(() => void refreshVisible(d), { parentId: null }));
			for (const id of expandedIds) {
				unsubs.push(d.subscribeChanges(() => void refreshVisible(d), { parentId: id }));
			}
		});
		return () => {
			for (const u of unsubs) u();
		};
	});
</script>

{#snippet node(entry: ExplorerEntry, depth: number)}
	{@const isFolder = entry.kind === 'folder'}
	{@const isOpen = isFolder && expanded.has(entry.id)}
	{@const isActive = activeId === entry.id}
	{@const kids = children.get(entry.id)}
	{@const isLoading = loading.has(entry.id)}
	<div class="fe-tree-row-wrap">
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="fe-tree-row"
			class:active={isActive}
			style="padding-left: {depth * 14 + 4}px"
			data-testid="fe-tree-row"
			data-id={entry.id}
			data-kind={entry.kind}
			role="treeitem"
			aria-selected={isActive}
			aria-expanded={isFolder ? isOpen : undefined}
			tabindex="-1"
			onclick={(e) => {
				if ((e.target as HTMLElement).closest('.fe-tree-toggle')) return;
				if (isFolder) {
					onNavigate(entry.id);
				} else {
					onSelect?.(entry);
				}
			}}
		>
			<button
				type="button"
				class="fe-tree-toggle"
				class:invisible={!isFolder || kids?.length === 0}
				data-testid="fe-tree-toggle"
				aria-label={isOpen ? 'Collapse folder' : 'Expand folder'}
				onclick={(e) => {
					e.stopPropagation();
					if (isFolder) toggleExpand(entry.id);
				}}
			>
				<FeIcon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} />
			</button>
			<FeIcon
				name={isFolder ? (isOpen ? 'folder-open' : 'folder') : 'file'}
				size={14}
			/>
			<span class="fe-tree-name" title={entry.name}>{entry.name}</span>
		</div>
		{#if isOpen}
			<div class="fe-tree-children" role="group">
				{#if isLoading && !kids}
					<div class="fe-tree-hint" style="padding-left: {(depth + 1) * 14 + 4}px">Loading…</div>
				{:else if kids && kids.length > 0}
					{#each kids as child (child.id)}
						{@render node(child, depth + 1)}
					{/each}
				{:else}
					<div class="fe-tree-hint" style="padding-left: {(depth + 1) * 14 + 4}px">Empty</div>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

<div class="fe-tree" data-testid="fe-tree-view" role="tree" aria-label="Folder tree">
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fe-tree-row fe-tree-root"
		class:active={activeId === null}
		class:hidden={!showRoot}
		data-testid="fe-tree-row-root"
		role="treeitem"
		aria-selected={activeId === null}
		tabindex="-1"
		onclick={() => onNavigate(null)}
	>
		<span class="fe-tree-toggle invisible" aria-hidden="true"></span>
		<FeIcon name="folder" size={14} />
		<span class="fe-tree-name">{rootLabel}</span>
	</div>
	<div class="fe-tree-children" role="group">
		{#if loading.has(ROOT_KEY) && !children.has(ROOT_KEY)}
			<div class="fe-tree-hint" style="padding-left: 18px">Loading…</div>
		{:else}
			{#each children.get(ROOT_KEY) ?? [] as child (child.id)}
				{@render node(child, 1)}
			{/each}
		{/if}
	</div>
</div>

<style>
	.fe-tree {
		font-size: var(--text-sm, 0.85rem);
		user-select: none;
	}
	.fe-tree-row {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 3px 4px;
		border-radius: var(--radius-sm, 3px);
		cursor: pointer;
		color: var(--text-secondary, inherit);
		white-space: nowrap;
	}
	.fe-tree-row:hover {
		background: rgb(var(--overlay-rgb) / 0.06);
	}
	.fe-tree-row.active {
		background: var(--accent-soft, rgb(var(--accent-rgb, 74 153 255) / 0.16));
		color: var(--text-primary);
	}
	.fe-tree-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		flex: none;
		border: 0;
		background: none;
		padding: 0;
		color: inherit;
		cursor: pointer;
		border-radius: var(--radius-sm, 3px);
	}
	.fe-tree-toggle:hover {
		background: rgb(var(--overlay-rgb) / 0.1);
	}
	.fe-tree-toggle.invisible {
		visibility: hidden;
		pointer-events: none;
	}
	.fe-tree-name {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.fe-tree-hint {
		padding-top: 2px;
		padding-bottom: 2px;
		color: var(--text-muted, #888);
		font-size: 0.78rem;
	}
	.fe-tree-root.hidden {
		display: none;
	}
</style>
