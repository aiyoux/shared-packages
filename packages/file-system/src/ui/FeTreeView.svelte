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
		rootId = null,
		rootLabel = 'Root',
		showRoot = true,
		onSelect,
		dropActive = false,
		dropTargetId = undefined as ExplorerEntryId | null | undefined,
		onDropInto,
		onDragOverInto
	}: {
		driver: ExplorerDriver;
		activeId: ExplorerEntryId | null;
		treeVersion?: number;
		onNavigate: (id: ExplorerEntryId | null) => void;
		/** When true, list files as well as folders. FileExplorer dock stays folders-only. */
		includeFiles?: boolean;
		/**
		 * Folder the tree is rooted at. `null` (default) is the driver root.
		 * Projects roots the tree at the git working tree, so the tree shows the
		 * project rather than everything on the connection.
		 */
		rootId?: ExplorerEntryId | null;
		rootLabel?: string;
		showRoot?: boolean;
		/** File row click when includeFiles. Folders still use onNavigate. */
		onSelect?: (entry: ExplorerEntry) => void;
		/** Same-pane move: highlight folders as drop targets. */
		dropActive?: boolean;
		dropTargetId?: ExplorerEntryId | null;
		onDropInto?: (parentId: ExplorerEntryId | null) => void;
		onDragOverInto?: (parentId: ExplorerEntryId | null) => void;
	} = $props();

	function onFolderDragOver(e: DragEvent, parentId: ExplorerEntryId | null) {
		if (!dropActive) return;
		e.preventDefault();
		e.stopPropagation();
		onDragOverInto?.(parentId);
	}

	function onFolderDrop(e: DragEvent, parentId: ExplorerEntryId | null) {
		if (!dropActive) return;
		e.preventDefault();
		e.stopPropagation();
		onDropInto?.(parentId);
	}

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

	async function refreshVisible(d: ExplorerDriver, root: ExplorerEntryId | null): Promise<void> {
		await loadChildren(d, root, true);
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

	// Driver swap (e.g. switching connections) or a new tree root: old ids
	// don't exist under the new driver, so reset everything and reload.
	$effect(() => {
		const d = driver;
		const root = rootId;
		untrack(() => {
			children = new Map();
			expanded = new Set();
			loading = new Set();
			void loadChildren(d, root);
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
		const root = rootId;
		untrack(() => {
			void v;
			void files;
			void refreshVisible(d, root);
		});
	});

	// Standalone live refresh: subscribe root + expanded folders on the
	// same driver watch stream FileExplorer already uses (no second client).
	$effect(() => {
		const d = driver;
		const root = rootId;
		const expandedIds = expanded;
		const unsubs: Array<() => void> = [];
		untrack(() => {
			if (!d.subscribeChanges) return;
			unsubs.push(d.subscribeChanges(() => void refreshVisible(d, root), { parentId: root }));
			for (const id of expandedIds) {
				unsubs.push(d.subscribeChanges(() => void refreshVisible(d, root), { parentId: id }));
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
			class:drop-ready={dropActive && isFolder}
			class:drop-target={dropActive && isFolder && dropTargetId === entry.id}
			style="padding-left: {depth * 14 + 4}px"
			data-testid="fe-tree-row"
			data-id={entry.id}
			data-kind={entry.kind}
			data-name={entry.name}
			data-fe-drop-parent={isFolder ? entry.id : undefined}
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
			ondragover={isFolder ? (e) => onFolderDragOver(e, entry.id) : undefined}
			ondrop={isFolder ? (e) => onFolderDrop(e, entry.id) : undefined}
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
		class:active={activeId === rootId}
		class:hidden={!showRoot}
		class:drop-ready={dropActive}
		class:drop-target={dropActive && dropTargetId === rootId}
		data-testid="fe-tree-row-root"
		data-fe-drop-parent=""
		role="treeitem"
		aria-selected={activeId === rootId}
		tabindex="-1"
		onclick={() => onNavigate(rootId)}
		ondragover={(e) => onFolderDragOver(e, rootId)}
		ondrop={(e) => onFolderDrop(e, rootId)}
	>
		<span class="fe-tree-toggle invisible" aria-hidden="true"></span>
		<FeIcon name="folder" size={14} />
		<span class="fe-tree-name">{rootLabel}</span>
	</div>
	<div class="fe-tree-children" role="group">
		{#if loading.has(keyFor(rootId)) && !children.has(keyFor(rootId))}
			<div class="fe-tree-hint" style="padding-left: 18px">Loading…</div>
		{:else}
			{#each children.get(keyFor(rootId)) ?? [] as child (child.id)}
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
	.fe-tree-row.drop-ready {
		outline: 1px dashed color-mix(in srgb, var(--accent, #38bdf8) 45%, transparent);
		outline-offset: -1px;
	}
	.fe-tree-row.drop-target {
		outline: 1px solid var(--accent, #38bdf8);
		background: rgb(var(--accent-rgb, 56 189 248) / 0.16);
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
