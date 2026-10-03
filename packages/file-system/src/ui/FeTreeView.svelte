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
	import { dataTransferHasExplorerIds } from './copyAcross.js';
	import { folderMarkFromKids, type FolderMark } from './detectProject.js';
	import { folderIconName, folderMarkClass } from './feIcons.js';

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
		onDragOverInto,
		showHidden = true
	}: {
		driver: ExplorerDriver;
		activeId: ExplorerEntryId | null;
		treeVersion?: number;
		/** Leading-dot rows shown when true. Standalone reuse shows everything;
		 *  FileExplorer passes its system-files toggle here. */
		showHidden?: boolean;
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
		const foreign = dataTransferHasExplorerIds(e.dataTransfer);
		if (!dropActive && !foreign) return;
		e.preventDefault();
		if (onDropInto) e.stopPropagation();
		if (e.dataTransfer && !onDropInto) e.dataTransfer.dropEffect = 'copy';
		onDragOverInto?.(parentId);
	}

	function onFolderDrop(e: DragEvent, parentId: ExplorerEntryId | null) {
		if (onDropInto) {
			e.preventDefault();
			e.stopPropagation();
			onDropInto(parentId);
			return;
		}
		if (dataTransferHasExplorerIds(e.dataTransfer)) e.preventDefault();
	}

	const ROOT_KEY = '__root__';

	let children = $state<Map<string, ExplorerEntry[]>>(new Map());
	/** Unfiltered list results so folder marks can see `.git` / `.project.json`. */
	let listed = $state<Map<string, ExplorerEntry[]>>(new Map());
	let marks = $state<Map<string, FolderMark>>(new Map());
	let expanded = $state<Set<string>>(new Set());
	let loading = $state<Set<string>>(new Set());
	let generation = 0;
	let pendingLists = new Map<string, Promise<void>>();

	function markFor(entry: ExplorerEntry): FolderMark {
		const kids = listed.get(entry.id);
		if (kids) return folderMarkFromKids(entry.meta, kids);
		return marks.get(entry.id) ?? folderMarkFromKids(entry.meta, []);
	}

	function markForId(id: ExplorerEntryId | null): FolderMark {
		const key = keyFor(id);
		const kids = listed.get(key);
		if (kids) return folderMarkFromKids(undefined, kids);
		return marks.get(key) ?? 'plain';
	}

	function keyFor(parentId: ExplorerEntryId | null): string {
		return parentId ?? ROOT_KEY;
	}

	/** Rows a node renders — folders only, unless the tree includes files. */
	function rowsFor(entries: ExplorerEntry[]): ExplorerEntry[] {
		return entries
			.filter((e) => (includeFiles || e.kind === 'folder'))
			.sort((a, b) => {
				if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
				return a.name.localeCompare(b.name);
			});
	}

	/** Rows displayed to the user: leading-dot names hidden until revealed.
	 *  Storage (`children`/`listed`) keeps the raw entries, so mark probing
	 *  still reads `.git` inside a parent the tree only shows bare. */
	function visibleRows(entries: ExplorerEntry[]): ExplorerEntry[] {
		if (showHidden) return entries;
		return entries.filter((e) => !e.name.startsWith('.'));
	}

	/** Fetch one folder only. A probe must never start another level of probes. */
	async function loadListing(
		d: ExplorerDriver,
		parentId: ExplorerEntryId | null,
		force = false,
		probe = false
	): Promise<void> {
		const key = keyFor(parentId);
		const pending = pendingLists.get(key);
		if (pending) return pending;
		if (!force && children.has(key)) return;
		const revision = generation;
		loading = new Set(loading).add(key);
		const request = Promise.resolve().then(async () => {
			try {
				const { entries } = await d.list({ parentId, ...(probe ? { probe: true } : {}) });
				if (revision !== generation) return;
				listed = new Map(listed).set(key, entries);
				marks = new Map(marks).set(key, folderMarkFromKids(undefined, entries));
				children = new Map(children).set(key, rowsFor(entries));
			} catch {
				// Best-effort navigation; keep the last known rows on a failed refresh.
			} finally {
				if (revision === generation) {
					pendingLists.delete(key);
					const next = new Set(loading);
					next.delete(key);
					loading = next;
				}
			}
		});
		pendingLists.set(key, request);
		return request;
	}

	async function loadChildren(d: ExplorerDriver, parentId: ExplorerEntryId | null): Promise<void> {
		const revision = generation;
		await loadListing(d, parentId);
		if (revision !== generation) return;
		// Only these child rows are on screen. Read one level for their marks
		// and chevrons; their own children stay unprobed until expanded.
		await Promise.all((children.get(keyFor(parentId)) ?? [])
			.filter((entry) => entry.kind === 'folder')
			.map((entry) => loadListing(d, entry.id, false, true)));
	}

	async function revealPath(d: ExplorerDriver, id: ExplorerEntryId | null): Promise<void> {
		if (!id) return;
		const revision = generation;
		try {
			const chain = await d.getPath(id); // root..id, inclusive of id itself
			if (revision !== generation) return;
			const chainIds = new Set<string>(chain.map((node) => node.id));
			for (const node of chain) {
				await loadChildren(d, node.id);
				if (revision !== generation) return;
			}
			// Re-read the live set right before assigning: the user may have
			// toggled a node while getPath / loadChildren were in flight, and
			// a stale snapshot would undo that toggle. Opening one folder
			// must not collapse a sibling that is already open.
			const next = new Set(expanded);
			for (const nid of chainIds) next.add(nid);
			expanded = next;
		} catch {
			/* best-effort nav aid; ignore */
		}
	}

	async function refreshVisible(d: ExplorerDriver, root: ExplorerEntryId | null): Promise<void> {
		const revision = generation;
		async function visit(parentId: ExplorerEntryId | null): Promise<void> {
			await loadListing(d, parentId, true);
			if (revision !== generation) return;
			await Promise.all((children.get(keyFor(parentId)) ?? [])
				.filter((entry) => entry.kind === 'folder')
				.map((entry) => expanded.has(entry.id)
					? visit(entry.id)
					: loadListing(d, entry.id, true, true)));
		}
		// Follow rendered rows, not the cache. Cached probes include children
		// of collapsed folders; refreshing those recursively crawls the disk.
		await visit(root);
	}

	function toggleExpand(id: ExplorerEntryId): void {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else {
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
			generation += 1;
			pendingLists = new Map();
			children = new Map();
			listed = new Map();
			marks = new Map();
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
	// FileExplorer; refresh visible rows, including collapsed rows whose
	// chevrons flip when a subfolder lands or the last one leaves.
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

	// Live refresh watches the current folder only, like a file manager: the
	// cost of watching is what is open, never the shape of the tree. Every
	// visible row refreshes on a change, navigation, or `treeVersion` bump.
	// Inside FileExplorer this is the folder its list already watches, so the
	// stream shares one server subscription. The local driver's global signal
	// still covers every folder.
	//
	// Deliberately NOT a `children` dependency: resubscribing replays the
	// backend's initial emission, which refreshes, which reassigns
	// `children`, which would resubscribe forever.
	$effect(() => {
		const d = driver;
		const root = rootId;
		const current = activeId ?? root;
		if (!d.subscribeChanges) return;
		const subscribe = d.subscribeChanges.bind(d);
		return untrack(() =>
			subscribe(() => void refreshVisible(d, root), { parentId: current })
		);
	});
</script>

{#snippet node(entry: ExplorerEntry, depth: number)}
	{@const isFolder = entry.kind === 'folder'}
	{@const isOpen = isFolder && expanded.has(entry.id)}
	{@const isActive = activeId === entry.id}
	{@const kids = children.get(entry.id)}
	{@const shown = visibleRows(kids ?? [])}
	{@const isLoading = loading.has(entry.id)}
	{@const folderMark = isFolder ? markFor(entry) : 'plain'}
	<!-- A folder with a known-empty child list gets no chevron: there is
		nothing to expand. Unknown (not yet probed) keeps the chevron.
		An open empty folder still shows one, so it can be collapsed. -->
	{@const expandable = !isFolder || kids === undefined || shown.length > 0 || isOpen}
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
			data-fe-folder-mark={isFolder ? folderMark : undefined}
			data-fe-drop-parent={isFolder ? entry.id : undefined}
			role="treeitem"
			aria-selected={isActive}
			aria-expanded={expandable && isFolder ? isOpen : undefined}
			tabindex="-1"
			onclick={(e) => {
				if ((e.target as HTMLElement).closest('.fe-tree-toggle')) return;
				if (isFolder) {
					// Navigating here opens the folder. It does not close it;
					// the chevron is the only collapse control.
					if (!expanded.has(entry.id)) {
						expanded = new Set(expanded).add(entry.id);
						void loadChildren(driver, entry.id);
					}
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
				class:invisible={!expandable}
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
				name={isFolder ? folderIconName(folderMark, isOpen) : 'file'}
				class={isFolder ? folderMarkClass(folderMark) : ''}
				size={14}
			/>
			<span class="fe-tree-name" title={entry.name}>{entry.name}</span>
		</div>
		{#if isOpen}
			<div class="fe-tree-children" role="group">
				{#if isLoading && !kids}
					<div class="fe-tree-hint" style="padding-left: {(depth + 1) * 14 + 4}px">
						<span class="fe-tree-toggle invisible" aria-hidden="true"></span>
						Loading…
					</div>
				{:else if shown.length > 0}
					{#each shown as child (child.id)}
						{@render node(child, depth + 1)}
					{/each}
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
		data-fe-folder-mark={markForId(rootId)}
		data-fe-drop-parent=""
		role="treeitem"
		aria-selected={activeId === rootId}
		tabindex="-1"
		onclick={() => onNavigate(rootId)}
		ondragover={(e) => onFolderDragOver(e, rootId)}
		ondrop={(e) => onFolderDrop(e, rootId)}
	>
		<span class="fe-tree-toggle invisible" aria-hidden="true"></span>
		<FeIcon
			name={folderIconName(markForId(rootId), true)}
			class={folderMarkClass(markForId(rootId))}
			size={14}
		/>
		<span class="fe-tree-name">{rootLabel}</span>
	</div>
	<div class="fe-tree-children" role="group">
		{#if loading.has(keyFor(rootId)) && !children.has(keyFor(rootId))}
			<div class="fe-tree-hint" style="padding-left: 18px">
				<span class="fe-tree-toggle invisible" aria-hidden="true"></span>
				Loading…
			</div>
		{:else}
			{#each visibleRows(children.get(keyFor(rootId)) ?? []) as child (child.id)}
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
		display: flex;
		align-items: center;
		gap: 4px;
		padding-top: 2px;
		padding-bottom: 2px;
		color: var(--text-muted, var(--text-secondary, #888));
		font-size: 0.78rem;
		font-style: italic;
		opacity: 0.65;
		pointer-events: none;
	}
	.fe-tree-root.hidden {
		display: none;
	}
</style>
