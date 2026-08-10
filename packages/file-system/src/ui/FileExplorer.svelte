<script lang="ts">
	import { tick } from 'svelte';
	import { getSharedVfs, isActionable, type FileTypeId, type VfsService, VfsError } from '../index.js';
	import {
		type ExplorerDriver,
		type ExplorerEntry,
		type ExplorerOpenTarget
	} from './explorerDriver.js';
	import { createLocalExplorerDriver } from './localExplorerDriver.js';
	import StoragePersistenceStatus from './StoragePersistenceStatus.svelte';
	import { createTreeDndSession, resolveDrop, zoneFromY, type DropZone } from './treeDnd/index.js';

	export type ExplorerMode = 'manage' | 'open' | 'save' | 'browse';

	export type ExplorerContext = {
		parentId: string | null;
		selectedIds: string[];
		backend: string;
		entries: ExplorerEntry[];
	};

	interface Props {
		mode?: ExplorerMode;
		accept?: FileTypeId[];
		hideIncompatible?: boolean;
		initialParentId?: string | null;
		defaultName?: string;
		multiSelect?: boolean;
		/** Preferred injection. If omitted, local driver from vfs. */
		driver?: ExplorerDriver;
		/** Legacy: used when driver omitted. */
		vfs?: VfsService;
		/**
		 * Show origin storage persistence chip (local Dexie/OPFS only).
		 * Default true when backend is local; ignored for remote drivers.
		 */
		showPersistence?: boolean;
		onOpen?: (entry: ExplorerOpenTarget) => void | Promise<void>;
		onSave?: (args: {
			parentId: string | null;
			name: string;
			entry?: ExplorerOpenTarget;
		}) => void | Promise<void>;
		onClose?: () => void;
		/** Selection + open folder for dual-pane copy-across. */
		onContextChange?: (ctx: ExplorerContext) => void;
		variant?: 'panel' | 'dialog';
		class?: string;
		compatLibraryTestId?: boolean;
		compatSaveTestId?: boolean;
	}

	let {
		mode = 'manage',
		accept,
		hideIncompatible = false,
		initialParentId = null,
		defaultName = '',
		multiSelect = false,
		driver: driverProp,
		vfs: vfsProp,
		showPersistence = true,
		onOpen,
		onSave,
		onClose,
		onContextChange,
		variant = 'panel',
		class: className = '',
		compatLibraryTestId = false,
		compatSaveTestId = false
	}: Props = $props();

	// Resolve driver once from props (local default). Re-create if prop identity changes via effect below.
	let driver = $state<ExplorerDriver>(
		driverProp ?? createLocalExplorerDriver(vfsProp ?? getSharedVfs())
	);
	let caps = $derived(driver.capabilities);
	/** Local SharedVFS instance when applicable (for persistence chip + meta). */
	let localVfs = $derived(
		driver.id === 'local' ? (vfsProp ?? getSharedVfs()) : null
	);
	let showPersistChip = $derived(showPersistence && driver.id === 'local' && !!localVfs);

	$effect(() => {
		if (driverProp) {
			driver = driverProp;
		} else {
			driver = createLocalExplorerDriver(vfsProp ?? getSharedVfs());
		}
	});

	let parentId = $state<string | null>(initialParentId);
	let nodes = $state<ExplorerEntry[]>([]);
	let listTruncated = $state(false);
	let breadcrumbs = $state<ExplorerEntry[]>([]);
	let selected = $state<Set<string>>(new Set());
	let saveName = $state(defaultName);
	let error = $state('');
	let showTrash = $state(false);
	/** True until the first list() completes (empty shell only). */
	let initialLoad = $state(true);
	/** True while a list/mutation refresh is in flight. */
	let listBusy = $state(false);
	/**
	 * Busy chrome. For folder/driver context changes it shows immediately.
	 * For light mutations it may wait {@link BUSY_OVERLAY_DELAY_MS} so fast ops
	 * don't flash. Overlay stays up until *new* nodes are painted (no old-list flash).
	 */
	let showBusyOverlay = $state(false);
	const BUSY_OVERLAY_DELAY_MS = 200;
	let busyOverlayTimer: ReturnType<typeof setTimeout> | null = null;
	let busyToken = 0;
	/** Ignore stale list() results when parentId/driver changes mid-flight. */
	let refreshGen = 0;
	/**
	 * Consecutive failed silent refreshes. Silent failures are swallowed to keep
	 * reconnects from flashing an error banner, so they need their own retry —
	 * otherwise a failure on the last change of a burst leaves the list stale
	 * with nothing left to trigger another attempt.
	 */
	let silentRetries = 0;
	const SILENT_RETRY_LIMIT = 2;
	const SILENT_RETRY_MS = 1_000;
	let silentRetryTimer: ReturnType<typeof setTimeout> | null = null;

	let newFolderOpen = $state(false);
	let newFolderName = $state('New Folder');
	let renamingId = $state<string | null>(null);
	let renameValue = $state('');
	let focusIndex = $state(-1);
	let clipboard = $state<{ mode: 'copy' | 'cut'; ids: string[] } | null>(null);
	let uploadBusy = $state(false);
	let fileInputEl: HTMLInputElement | undefined = $state();

	/** Per-instance DnD session (dual-pane safe). */
	const dnd = createTreeDndSession();
	let dndTargetId = $state<string | null>(null);
	let dndZone = $state<DropZone | null>(null);

	// Cap-gated only — do not fold listBusy into the attribute or rows flicker
	// non-draggable during refresh paint (and component tests race listBusy).
	const dndEnabled = $derived(
		mode === 'manage' && !showTrash && caps.supportsMove
	);

	// Notify parent of selection/folder without tracking unstable callback identity
	let lastCtxKey = '';
	$effect(() => {
		const ids = [...selected].sort().join(',');
		const key = `${driver.id}|${parentId ?? ''}|${ids}|${nodes.length}`;
		if (key === lastCtxKey) return;
		lastCtxKey = key;
		onContextChange?.({
			parentId,
			selectedIds: [...selected],
			backend: driver.id,
			entries: nodes
		});
	});

	function errMsg(e: unknown): string {
		if (e instanceof VfsError) return e.code;
		if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
			return (e as { code: string }).code;
		}
		return e instanceof Error ? e.message : String(e);
	}

	function onRowDragStart(e: DragEvent, n: ExplorerEntry) {
		if (!dndEnabled) {
			e.preventDefault();
			return;
		}
		// Interactive controls (checkbox / rename / buttons) must not start a row drag
		const t = e.target as HTMLElement | null;
		if (t?.closest?.('input, button, a, [contenteditable="true"]')) {
			e.preventDefault();
			return;
		}
		const ids =
			selected.has(n.id) && selected.size > 0 ? [...selected] : [n.id];
		dnd.startDrag(ids, parentId);
		try {
			e.dataTransfer?.setData('text/plain', ids.join(','));
		} catch {
			/* jsdom may lack full DataTransfer */
		}
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}

	function onRowDragOver(e: DragEvent, n: ExplorerEntry) {
		if (!dnd.getState().active) return;
		e.preventDefault();
		const el = e.currentTarget as HTMLElement;
		const rect = el.getBoundingClientRect();
		let zone = zoneFromY({ top: rect.top, height: rect.height }, e.clientY);
		if (!caps.supportsSiblingOrder) {
			// into-only for remotes; force into when over folder, else ignore
			if (n.kind !== 'folder') {
				dnd.clearDropTarget();
				dndTargetId = null;
				dndZone = null;
				return;
			}
			zone = 'into';
		}
		dnd.setDropTarget(n.id, zone);
		dndTargetId = n.id;
		dndZone = zone;
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
	}

	function onListDragOver(e: DragEvent) {
		if (!dnd.getState().active) return;
		// empty list / padding → drop into current parent
		if ((e.target as HTMLElement).closest?.('.fe-row')) return;
		e.preventDefault();
		dnd.setDropTarget(null, 'into');
		dndTargetId = null;
		dndZone = 'into';
	}

	async function commitDndDrop(target: ExplorerEntry | null) {
		const st = dnd.getState();
		if (!st.active || !st.primaryId) {
			dnd.stopDrag();
			dndTargetId = null;
			dndZone = null;
			return;
		}
		const zone = st.zone;
		const dragIds = st.dragIds;
		try {
			if (target) {
				const resolved = resolveDrop({
					dragIds,
					target: { id: target.id, parentId: target.parentId, kind: target.kind },
					zone,
					supportsSiblingOrder: caps.supportsSiblingOrder
				});
				if (!resolved.ok) {
					// silent no-op for unsupported remote before/after
					return;
				}
				for (const id of dragIds) {
					if (resolved.mode === 'move-into') {
						if (id === resolved.newParentId) continue;
						await driver.move?.(id, resolved.newParentId);
					} else if (caps.supportsSiblingOrder && driver.reorder) {
						const node = nodes.find((x) => x.id === id);
						if (node && node.parentId !== resolved.newParentId) {
							await driver.move?.(id, resolved.newParentId);
						}
						await driver.reorder(id, {
							beforeId: resolved.beforeId,
							afterId: resolved.afterId
						});
					}
				}
			} else if (zone === 'into' || zone === null) {
				// drop on empty / list chrome → stay at parent (no-op) or no target
			}
			await refresh();
		} catch (err) {
			error = errMsg(err);
		} finally {
			dnd.stopDrag();
			dndTargetId = null;
			dndZone = null;
		}
	}

	function onRowDrop(e: DragEvent, n: ExplorerEntry) {
		e.preventDefault();
		e.stopPropagation();
		void commitDndDrop(n);
	}

	function onRowDragEnd() {
		dnd.stopDrag();
		dndTargetId = null;
		dndZone = null;
	}

	function beginListBusy(opts?: { immediate?: boolean }) {
		const token = ++busyToken;
		listBusy = true;
		if (opts?.immediate) {
			if (busyOverlayTimer) {
				clearTimeout(busyOverlayTimer);
				busyOverlayTimer = null;
			}
			showBusyOverlay = true;
			return;
		}
		// Keep overlay if already up (chained refreshes)
		if (showBusyOverlay) return;
		if (busyOverlayTimer) clearTimeout(busyOverlayTimer);
		busyOverlayTimer = setTimeout(() => {
			if (token === busyToken && listBusy) {
				showBusyOverlay = true;
			}
		}, BUSY_OVERLAY_DELAY_MS);
	}

	/**
	 * Drop busy chrome only after the current list paint is committed, so the
	 * user never sees: spinner off → old rows → new rows.
	 */
	async function endListBusyAfterPaint() {
		const hadOverlay = showBusyOverlay;
		if (hadOverlay) {
			// Let Svelte commit `nodes` under the still-visible overlay
			await tick();
			await new Promise<void>((r) => requestAnimationFrame(() => r()));
		}
		busyToken += 1;
		if (busyOverlayTimer) {
			clearTimeout(busyOverlayTimer);
			busyOverlayTimer = null;
		}
		listBusy = false;
		showBusyOverlay = false;
	}

	function clearSilentRetry() {
		if (silentRetryTimer) {
			clearTimeout(silentRetryTimer);
			silentRetryTimer = null;
		}
	}

	function scheduleSilentRetry() {
		clearSilentRetry();
		silentRetryTimer = setTimeout(() => {
			silentRetryTimer = null;
			void refresh(true, 'delay', true);
		}, SILENT_RETRY_MS);
	}

	/**
	 * Reload list + breadcrumbs.
	 * @param manageBusy - when false, caller owns begin/endListBusy (e.g. delete).
	 * @param busyMode - `immediate` covers folder/driver switches; `delay` for light ops.
	 * @param silent - background refresh driven by a live backend, not by the user.
	 *   Paints no busy chrome and skips the `ready()` probe: rows are keyed by id,
	 *   so an unchanged list re-commits to the same DOM and the user sees nothing.
	 *   Without this every watch event dimmed the list (`cursor: wait`, rows
	 *   `pointer-events: none`, toolbar disabled) for the length of three round
	 *   trips, which is what read as flicker under a stream of file changes.
	 */
	async function refresh(
		manageBusy = true,
		busyMode: 'delay' | 'immediate' = 'delay',
		silent = false
	) {
		const gen = ++refreshGen;
		// Any newer refresh subsumes a queued retry.
		clearSilentRetry();
		if (manageBusy && !silent) beginListBusy({ immediate: busyMode === 'immediate' });
		// A background refresh must not clear an error the user hasn't addressed.
		if (!silent) error = '';
		try {
			// The SSE stream arriving *is* the liveness probe for a silent refresh.
			if (!silent) await driver.ready();
			if (gen !== refreshGen) return;

			let nextNodes: ExplorerEntry[];
			let nextTruncated: boolean;
			let nextCrumbs: ExplorerEntry[];
			if (showTrash && mode === 'manage' && caps.supportsTrash) {
				const result = await driver.list({ parentId: null, trashOnly: true });
				nextNodes = result.entries;
				nextTruncated = result.truncated;
				nextCrumbs = [];
			} else {
				const result = await driver.list({ parentId });
				nextNodes = result.entries;
				nextTruncated = result.truncated;
				nextCrumbs = parentId ? await driver.getPath(parentId) : [];
			}
			if (gen !== refreshGen) return;

			if (hideIncompatible && accept?.length) {
				nextNodes = nextNodes.filter(
					(n) => n.kind === 'folder' || isActionable(n as never, accept)
				);
			}
			// Commit data while overlay still covers the list (when shown)
			nodes = nextNodes;
			listTruncated = nextTruncated;
			breadcrumbs = nextCrumbs;
			if (focusIndex >= nodes.length) focusIndex = nodes.length ? nodes.length - 1 : -1;
			silentRetries = 0;
		} catch (e) {
			if (gen !== refreshGen) return;
			if (!silent) {
				error = errMsg(e);
			} else if (silentRetries < SILENT_RETRY_LIMIT) {
				// A failed background poll keeps the last good list rather than
				// flashing red on every reconnect — but a silent failure is also how
				// the list goes stale without saying so. If this was the last change
				// in a burst, nothing else will retry, so retry here.
				silentRetries += 1;
				scheduleSilentRetry();
			} else {
				// Persistently failing: staleness the user cannot see is worse than
				// an error they can act on.
				silentRetries = 0;
				error = errMsg(e);
			}
		} finally {
			// Only the latest refresh may clear busy
			if (gen === refreshGen) {
				initialLoad = false;
				// A silent refresh raises no chrome — but if it superseded one that
				// did, that refresh bailed at this same guard, so clearing up is now
				// this one's job or the overlay sticks.
				if (manageBusy && (!silent || listBusy)) await endListBusyAfterPaint();
			}
		}
	}

	$effect(() => {
		void parentId;
		void showTrash;
		void mode;
		void driver;
		// A new folder does not inherit the last one's failure streak.
		silentRetries = 0;
		// Folder / backend context change: cover list immediately
		void refresh(true, 'immediate');
	});

	/** Live backends (monitor watch): re-list open folder when driver signals change. */
	$effect(() => {
		const d = driver;
		if (!d.subscribeChanges) return;
		const unsub = d.subscribeChanges(() => {
			// Silent — keeps selection, and paints no busy chrome for a change the
			// user did not initiate.
			void refresh(true, 'delay', true);
		});
		return () => {
			unsub();
			clearSilentRetry();
		};
	});

	function rowActionable(n: ExplorerEntry): boolean {
		if (showTrash) return true;
		return isActionable(n as never, accept);
	}

	function focusedNode(): ExplorerEntry | null {
		if (focusIndex < 0 || focusIndex >= nodes.length) return null;
		return nodes[focusIndex] ?? null;
	}

	async function enterFolder(n: ExplorerEntry) {
		if (n.kind !== 'folder') return;
		showTrash = false;
		parentId = n.id;
		selected = new Set();
		focusIndex = -1;
	}

	async function goCrumb(id: string | null) {
		showTrash = false;
		parentId = id;
		selected = new Set();
		focusIndex = -1;
	}

	async function goUp() {
		if (showTrash) {
			showTrash = false;
			return;
		}
		if (!parentId) return;
		const path = await driver.getPath(parentId);
		const parent = path.length >= 2 ? path[path.length - 2] : null;
		await goCrumb(parent?.id ?? null);
	}

	async function activate(n: ExplorerEntry) {
		if (n.kind === 'folder') {
			await enterFolder(n);
			return;
		}
		if (!rowActionable(n)) return;
		if (mode === 'open' || mode === 'manage') {
			await onOpen?.(n);
		}
		if (mode === 'save') {
			saveName = n.name;
		}
	}

	async function confirmSave() {
		if (!onSave) return;
		let name = saveName.trim();
		if (!name) {
			error = 'Name required';
			return;
		}
		if (accept?.[0]) {
			const { forceExtension } = await import('../registry.js');
			name = forceExtension(name, accept[0]);
		}
		try {
			await onSave({ parentId, name });
		} catch (e) {
			error = errMsg(e);
		}
	}

	async function createFolder() {
		if (!driver.mkdir || !caps.supportsMkdir) return;
		try {
			await driver.mkdir(parentId, newFolderName || 'New Folder');
			newFolderOpen = false;
			newFolderName = 'New Folder';
			await refresh();
		} catch (e) {
			error = errMsg(e);
		}
	}

	function confirmHardDelete(ids: string[], names: string[]): boolean {
		if (caps.supportsSoftDelete) return true;
		if (ids.length === 1) {
			const name = names[0] ?? 'item';
			return window.confirm(
				`Delete “${name}” permanently from remote storage? This removes all versions.`
			);
		}
		return window.confirm(
			`Delete ${ids.length} items permanently from remote storage? All versions will be removed.`
		);
	}

	async function deleteIds(ids: string[]) {
		if (!ids.length) return;
		const names = ids.map((id) => nodes.find((n) => n.id === id)?.name ?? id);
		if (!confirmHardDelete(ids, names)) return;
		// Optimistic remove so the row doesn't sit there through a slow remote delete
		const idSet = new Set(ids);
		const snapshot = nodes;
		nodes = nodes.filter((n) => !idSet.has(n.id));
		selected = new Set();
		if (focusIndex >= nodes.length) focusIndex = nodes.length ? nodes.length - 1 : -1;

		const failures: string[] = [];
		// Single busy span for delete + reconcile (avoids overlay flash off/on)
		beginListBusy();
		try {
			for (const id of ids) {
				try {
					await driver.delete(id);
				} catch (e) {
					failures.push(`${errMsg(e)}: ${names[ids.indexOf(id)] ?? id}`);
				}
			}
			// Reconcile with server while still covered; apply new list under busy chrome
			await refresh(false);
		} finally {
			await endListBusyAfterPaint();
		}
		if (failures.length) {
			// Put failed items back if still missing after reconcile
			const have = new Set(nodes.map((n) => n.id));
			const restored = snapshot.filter((n) => idSet.has(n.id) && !have.has(n.id));
			if (restored.length) nodes = [...nodes, ...restored];
			error =
				failures.length === 1
					? failures[0]!
					: `${failures[0]} (and ${failures.length - 1} other errors)`;
		}
	}

	async function trashSelected() {
		await deleteIds([...selected]);
	}

	async function trashFocusedOrSelected() {
		if (showTrash || mode === 'browse') return;
		const ids =
			selected.size > 0
				? [...selected]
				: focusedNode()
					? [focusedNode()!.id]
					: [];
		await deleteIds(ids);
	}

	async function restoreNode(n: ExplorerEntry) {
		if (!driver.restore) return;
		await driver.restore(n.id);
		await refresh();
	}

	async function permanentNode(n: ExplorerEntry) {
		if (!driver.permanentDelete) return;
		if (!window.confirm(`Permanently delete “${n.name}”? This cannot be undone.`)) return;
		await driver.permanentDelete(n.id);
		await refresh();
	}

	async function emptyTrash() {
		if (!driver.emptyTrash) return;
		if (!window.confirm('Empty trash? All items will be permanently deleted.')) return;
		await driver.emptyTrash();
		await refresh();
	}

	async function commitRename(n: ExplorerEntry) {
		if (!driver.rename || !caps.supportsRename) return;
		try {
			await driver.rename(n.id, renameValue);
			renamingId = null;
			error = '';
			await refresh();
		} catch (e) {
			error = errMsg(e);
		}
	}

	function startRename(n: ExplorerEntry) {
		if (mode !== 'manage' || showTrash || !caps.supportsRename) return;
		renamingId = n.id;
		renameValue = n.name;
	}

	function toggleSelect(id: string, e: MouseEvent) {
		if (!multiSelect && mode !== 'manage') return;
		e.stopPropagation();
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
	}

	function idsForClipboard(): string[] {
		if (selected.size > 0) return [...selected];
		const n = focusedNode();
		return n ? [n.id] : [];
	}

	function cutSelection() {
		if (mode !== 'manage' || showTrash || !caps.supportsMove) return;
		const ids = idsForClipboard();
		if (!ids.length) return;
		clipboard = { mode: 'cut', ids };
	}

	function copySelection() {
		if (mode !== 'manage' || showTrash || !caps.supportsCopy) return;
		const ids = idsForClipboard();
		if (!ids.length) return;
		clipboard = { mode: 'copy', ids };
	}

	async function pasteClipboard() {
		if (mode !== 'manage' || showTrash || !clipboard?.ids.length) return;
		error = '';
		try {
			for (const id of clipboard.ids) {
				if (clipboard.mode === 'cut') {
					if (!driver.move || !caps.supportsMove) throw new Error('MOVE_UNSUPPORTED');
					await driver.move(id, parentId);
				} else {
					if (!driver.copy || !caps.supportsCopy) throw new Error('COPY_UNSUPPORTED');
					await driver.copy(id, parentId);
				}
			}
			if (clipboard.mode === 'cut') clipboard = null;
			selected = new Set();
			await refresh();
		} catch (e) {
			error = errMsg(e);
		}
	}

	async function copyNode(n: ExplorerEntry) {
		if (mode !== 'manage' || showTrash || !driver.copy || !caps.supportsCopy) return;
		try {
			await driver.copy(n.id, parentId);
			await refresh();
		} catch (e) {
			error = errMsg(e);
		}
	}

	async function downloadNode(n: ExplorerEntry) {
		if (!driver.download || !caps.supportsDownload || n.kind !== 'file') return;
		try {
			const blob = await driver.download(n.id);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = n.name;
			a.rel = 'noopener';
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		} catch (e) {
			error = errMsg(e);
		}
	}

	async function onUploadFiles(files: FileList | null) {
		if (!files?.length || !driver.upload || !caps.supportsUpload) return;
		uploadBusy = true;
		error = '';
		try {
			for (const file of Array.from(files)) {
				await driver.upload(parentId, file);
			}
			await refresh();
		} catch (e) {
			error = errMsg(e);
		} finally {
			uploadBusy = false;
			if (fileInputEl) fileInputEl.value = '';
		}
	}

	function onListKeydown(e: KeyboardEvent) {
		const t = e.target as HTMLElement | null;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (!nodes.length) return;
			focusIndex = Math.min(nodes.length - 1, Math.max(0, focusIndex) + 1);
			return;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (!nodes.length) return;
			focusIndex = Math.max(0, (focusIndex < 0 ? 0 : focusIndex) - 1);
			return;
		}
		if (e.key === 'Enter') {
			const n = focusedNode();
			if (n) {
				e.preventDefault();
				void activate(n);
			}
			return;
		}
		if (e.key === 'F2') {
			const n = focusedNode();
			if (n && mode === 'manage' && !showTrash && caps.supportsRename) {
				e.preventDefault();
				startRename(n);
			}
			return;
		}
		if (e.key === 'Delete') {
			if (mode === 'manage' && !showTrash) {
				e.preventDefault();
				void trashFocusedOrSelected();
			}
			return;
		}
		if (e.key === 'Backspace') {
			e.preventDefault();
			if ((e.metaKey || e.ctrlKey) && mode === 'manage' && !showTrash) {
				void trashFocusedOrSelected();
			} else {
				void goUp();
			}
			return;
		}
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
			if (mode === 'manage' && caps.supportsCopy) {
				e.preventDefault();
				copySelection();
			}
			return;
		}
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
			if (mode === 'manage' && caps.supportsMove) {
				e.preventDefault();
				cutSelection();
			}
			return;
		}
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
			if (mode === 'manage' && (caps.supportsMove || caps.supportsCopy)) {
				e.preventDefault();
				void pasteClipboard();
			}
		}
	}

	const rootTestId = compatLibraryTestId
		? 'library-modal'
		: compatSaveTestId
			? 'save-modal'
			: 'file-explorer';
</script>

<div
	class="fe-root {variant} {className}"
	data-testid={rootTestId}
	data-fe-backend={driver.id}
	data-fe-mode={mode}
	role={variant === 'dialog' ? 'dialog' : 'group'}
	aria-label="File explorer"
	tabindex="0"
	onkeydown={onListKeydown}
>
	<header class="fe-header" data-testid="fe-header">
		<div class="fe-breadcrumbs" data-testid="fe-breadcrumbs">
			<button type="button" class="fe-crumb" data-testid="fe-crumb-root" onclick={() => goCrumb(null)}>
				Root
			</button>
			{#each breadcrumbs as crumb (crumb.id)}
				<span class="fe-sep">/</span>
				<button
					type="button"
					class="fe-crumb"
					data-testid="fe-crumb"
					data-id={crumb.id}
					onclick={() => goCrumb(crumb.id)}
				>
					{crumb.name}
				</button>
			{/each}
			{#if showTrash && caps.supportsTrash}
				<span class="fe-sep">/</span>
				<span class="fe-crumb active">Trash</span>
			{/if}
		</div>
		<div class="fe-toolbar" data-testid="fe-toolbar">
			{#if showPersistChip && localVfs}
				<StoragePersistenceStatus vfs={localVfs} compact class="fe-persist-slot" />
			{/if}
			{#if mode === 'manage' && caps.supportsSiblingOrder && !showTrash}
				<span
					class="fe-dnd-hint"
					data-testid="fe-dnd-hint"
					title="Drag a row before/after a sibling to reorder. Drop onto a folder to move into it."
				>
					Drag to reorder
				</span>
			{/if}
			{#if mode === 'manage'}
				{#if caps.supportsMkdir}
					<button type="button" data-testid="fe-new-folder" onclick={() => (newFolderOpen = true)}>
						New folder
					</button>
				{/if}
				{#if caps.supportsUpload}
					<button
						type="button"
						data-testid="fe-upload"
						disabled={uploadBusy}
						onclick={() => fileInputEl?.click()}
					>
						{uploadBusy ? 'Uploading…' : 'Upload'}
					</button>
					<input
						bind:this={fileInputEl}
						type="file"
						multiple
						hidden
						data-testid="fe-upload-input"
						onchange={(e) => onUploadFiles((e.currentTarget as HTMLInputElement).files)}
					/>
				{/if}
				{#if caps.supportsTrash}
					<button
						type="button"
						data-testid="fe-trash-view"
						class:active={showTrash}
						onclick={() => {
							showTrash = !showTrash;
							parentId = null;
						}}
					>
						Trash
					</button>
				{/if}
				{#if selected.size}
					<button type="button" data-testid="fe-trash-selected" onclick={trashSelected}>
						Delete
					</button>
					{#if caps.supportsMove}
						<button type="button" data-testid="fe-cut" onclick={cutSelection}>Cut</button>
					{/if}
					{#if caps.supportsCopy}
						<button type="button" data-testid="fe-copy" onclick={copySelection}>Copy</button>
					{/if}
				{/if}
				{#if clipboard?.ids.length && !showTrash && (caps.supportsMove || caps.supportsCopy)}
					<button type="button" data-testid="fe-paste" onclick={() => pasteClipboard()}>
						Paste {clipboard.mode === 'cut' ? '(move)' : '(copy)'}
					</button>
				{/if}
				{#if showTrash && caps.supportsTrash}
					<button type="button" data-testid="fe-empty-trash" onclick={emptyTrash}>Empty trash</button>
				{/if}
			{/if}
			{#if onClose}
				<button type="button" class="fe-close" data-testid="fe-close" aria-label="Close" onclick={onClose}>
					×
				</button>
			{/if}
		</div>
	</header>

	{#if error}
		<div class="fe-error" data-testid="fe-error" role="alert">{error}</div>
	{/if}

	{#if listTruncated}
		<div class="fe-truncated" data-testid="fe-list-truncated" role="status">
			Showing first 2000 items
		</div>
	{/if}

	{#if newFolderOpen && caps.supportsMkdir}
		<div class="fe-inline-form" data-testid="fe-new-folder-form">
			<input data-testid="fe-new-folder-input" bind:value={newFolderName} />
			<button type="button" data-testid="fe-new-folder-confirm" onclick={createFolder}>Create</button>
			<button type="button" onclick={() => (newFolderOpen = false)}>Cancel</button>
		</div>
	{/if}

	<div
		class="fe-list"
		class:fe-list-busy={listBusy}
		class:fe-list-covered={showBusyOverlay}
		data-testid="fe-list"
		role="listbox"
		aria-busy={listBusy ? 'true' : undefined}
		ondragover={onListDragOver}
	>
		{#if initialLoad && nodes.length === 0}
			<div class="fe-empty" data-testid="fe-loading">Loading…</div>
		{:else if nodes.length === 0}
			<div class="fe-empty" data-testid="fe-empty">
				{showTrash ? 'Trash is empty' : 'No files here'}
			</div>
		{:else}
			{#each nodes as n, i (n.id)}
				{@const actionable = rowActionable(n)}
				{@const showBefore =
					dndEnabled && caps.supportsSiblingOrder && dndTargetId === n.id && dndZone === 'before'}
				{@const showAfter =
					dndEnabled && caps.supportsSiblingOrder && dndTargetId === n.id && dndZone === 'after'}
				{@const showInto =
					dndEnabled && dndTargetId === n.id && dndZone === 'into' && n.kind === 'folder'}
				{#if showBefore}
					<div class="fe-dnd-line" data-testid="fe-dnd-line-before" aria-hidden="true"></div>
				{/if}
				<div
					class="fe-row"
					class:folder={n.kind === 'folder'}
					class:file={n.kind === 'file'}
					class:incompatible={!actionable && n.kind === 'file'}
					class:selected={selected.has(n.id)}
					class:focused={i === focusIndex}
					class:fe-dnd-into={showInto}
					data-testid={n.kind === 'folder' ? 'fe-folder-row' : 'fe-file-row'}
					data-fe-row-id={n.id}
					data-fe-parent-id={n.parentId ?? ''}
					data-fe-kind={n.kind}
					data-fe-sort-order={n.sortOrder ?? ''}
					data-file-type={n.fileType ?? ''}
					data-id={n.id}
					data-name={n.name}
					draggable={dndEnabled}
					aria-disabled={!actionable && n.kind === 'file' ? 'true' : undefined}
					aria-selected={selected.has(n.id) || i === focusIndex}
					role="option"
					tabindex="-1"
					ondragstart={(e) => onRowDragStart(e, n)}
					ondragover={(e) => onRowDragOver(e, n)}
					ondrop={(e) => onRowDrop(e, n)}
					ondragend={onRowDragEnd}
					onclick={() => {
						if (listBusy) return;
						focusIndex = i;
						void activate(n);
					}}
				>
					{#if multiSelect || mode === 'manage'}
						<input
							type="checkbox"
							data-testid="fe-select"
							checked={selected.has(n.id)}
							disabled={listBusy}
							onclick={(e) => toggleSelect(n.id, e)}
						/>
					{/if}
					<span class="fe-icon">{n.kind === 'folder' ? '📁' : '📄'}</span>
					{#if renamingId === n.id}
						<input
							data-testid="fe-rename-input"
							bind:value={renameValue}
							onclick={(e) => e.stopPropagation()}
							onkeydown={(e) => {
								if (e.key === 'Enter') commitRename(n);
								if (e.key === 'Escape') renamingId = null;
							}}
						/>
					{:else}
						<span class="fe-name" title={!actionable && n.kind === 'file' ? 'Wrong type for this app' : n.name}
							>{n.name}</span
						>
					{/if}
					{#if showTrash && caps.supportsTrash}
						<button
							type="button"
							data-testid="fe-restore"
							disabled={listBusy}
							onclick={(e) => {
								e.stopPropagation();
								restoreNode(n);
							}}>Restore</button
						>
						<button
							type="button"
							data-testid="fe-permanent-delete"
							disabled={listBusy}
							onclick={(e) => {
								e.stopPropagation();
								permanentNode(n);
							}}>Delete forever</button
						>
					{:else if mode === 'manage' && actionable}
						{#if caps.supportsRename}
							<button
								type="button"
								data-testid="fe-rename-btn"
								disabled={listBusy}
								onclick={(e) => {
									e.stopPropagation();
									startRename(n);
								}}>Rename</button
							>
						{/if}
						{#if caps.supportsCopy && n.kind === 'file'}
							<button
								type="button"
								data-testid="fe-row-copy"
								disabled={listBusy}
								onclick={(e) => {
									e.stopPropagation();
									void copyNode(n);
								}}>Copy</button
							>
						{/if}
						{#if caps.supportsDownload && n.kind === 'file'}
							<button
								type="button"
								data-testid="fe-row-download"
								disabled={listBusy}
								onclick={(e) => {
									e.stopPropagation();
									void downloadNode(n);
								}}>Download</button
							>
						{/if}
						<button
							type="button"
							data-testid="fe-row-trash"
							disabled={listBusy}
							onclick={(e) => {
								e.stopPropagation();
								void deleteIds([n.id]);
							}}>Delete</button
						>
					{/if}
				</div>
				{#if showAfter}
					<div class="fe-dnd-line" data-testid="fe-dnd-line-after" aria-hidden="true"></div>
				{/if}
			{/each}
		{/if}

		{#if showBusyOverlay}
			<div class="fe-busy-overlay" data-testid="fe-busy-overlay" aria-live="polite" aria-label="Updating file list">
				<div class="fe-spinner" aria-hidden="true"></div>
			</div>
		{/if}
	</div>

	{#if mode === 'save'}
		<footer class="fe-save-bar" data-testid="fe-save-bar">
			<label>
				Name
				<input id="save-name" data-testid="fe-name-input" bind:value={saveName} />
			</label>
			<button type="button" data-testid="fe-save-confirm" onclick={confirmSave}>Save</button>
		</footer>
	{/if}

	{#if mode === 'open'}
		<footer class="fe-open-bar" data-testid="fe-open-bar">
			<span class="fe-hint">Double-click or select a compatible file to open</span>
		</footer>
	{/if}
</div>

<style>
	.fe-root {
		display: flex;
		flex-direction: column;
		min-height: 280px;
		max-height: 70vh;
		background: var(--fe-bg, #1a1b1e);
		color: var(--fe-fg, #e8e8ea);
		border: 1px solid var(--fe-border, #333);
		border-radius: 10px;
		overflow: hidden;
		font-family: system-ui, sans-serif;
		font-size: 14px;
	}
	.fe-header {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--fe-border, #333);
		flex-wrap: wrap;
	}
	.fe-breadcrumbs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
	}
	.fe-crumb {
		background: none;
		border: none;
		color: var(--fe-accent, #7cb7ff);
		cursor: pointer;
		padding: 2px 4px;
	}
	.fe-crumb.active {
		color: inherit;
		cursor: default;
	}
	.fe-toolbar {
		display: flex;
		gap: 6px;
		align-items: center;
		flex-wrap: wrap;
	}
	.fe-toolbar button {
		background: #2a2b30;
		border: 1px solid #444;
		color: inherit;
		border-radius: 6px;
		padding: 4px 8px;
		cursor: pointer;
	}
	.fe-toolbar button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.fe-toolbar button.active {
		outline: 1px solid var(--fe-accent, #7cb7ff);
	}
	.fe-dnd-hint {
		font-size: 0.72rem;
		color: #94a3b8;
		padding: 2px 6px;
		border-radius: 6px;
		border: 1px dashed #475569;
		white-space: nowrap;
	}
	.fe-close {
		font-size: 18px;
		line-height: 1;
	}
	.fe-list {
		position: relative;
		flex: 1;
		overflow: auto;
		padding: 6px;
		min-height: 120px;
	}
	.fe-list-busy {
		/* Soft cue even before delayed overlay appears */
		cursor: wait;
	}
	.fe-busy-overlay {
		position: absolute;
		inset: 0;
		z-index: 5;
		display: flex;
		align-items: center;
		justify-content: center;
		/* Opaque enough that the previous list is not readable underneath */
		background: color-mix(in srgb, var(--fe-bg, #1a1b1e) 92%, transparent);
		backdrop-filter: blur(2px);
		animation: fe-busy-fade 0.12s ease-out;
		pointer-events: all;
	}
	/* Hide previous list under the spinner so only the post-load list is seen */
	.fe-list-covered > :not(.fe-busy-overlay) {
		visibility: hidden;
	}
	.fe-list-busy .fe-row {
		pointer-events: none;
	}
	.fe-spinner {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		border: 3px solid color-mix(in srgb, var(--fe-fg, #e8e8ea) 18%, transparent);
		border-top-color: var(--fe-accent, #7cb7ff);
		animation: fe-spin 0.7s linear infinite;
	}
	@keyframes fe-busy-fade {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes fe-spin {
		to {
			transform: rotate(360deg);
		}
	}
	.fe-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		border-radius: 6px;
		cursor: pointer;
	}
	.fe-row button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.fe-row:hover {
		background: #2a2b30;
	}
	.fe-row.incompatible {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.fe-row.selected {
		background: #2c3a4f;
	}
	.fe-dnd-line {
		height: 2px;
		margin: 0 0.5rem;
		background: #38bdf8;
		border-radius: 1px;
	}
	.fe-row.fe-dnd-into {
		outline: 2px solid #38bdf8;
		outline-offset: -2px;
	}
	.fe-row.focused {
		outline: 1px solid #6ea8fe;
		outline-offset: -1px;
	}
	.fe-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.fe-empty {
		padding: 24px;
		text-align: center;
		opacity: 0.7;
	}
	.fe-error {
		padding: 8px 12px;
		background: #4a2020;
		color: #ffb4b4;
	}
	.fe-truncated {
		padding: 6px 12px;
		background: #2a2a18;
		color: #e8d48b;
		font-size: 12px;
	}
	.fe-save-bar,
	.fe-open-bar,
	.fe-inline-form {
		display: flex;
		gap: 8px;
		padding: 10px 12px;
		border-top: 1px solid var(--fe-border, #333);
		align-items: center;
	}
	.fe-save-bar input,
	.fe-inline-form input,
	input[data-testid='fe-rename-input'] {
		background: #111;
		border: 1px solid #444;
		color: inherit;
		border-radius: 4px;
		padding: 4px 8px;
	}
	.fe-hint {
		opacity: 0.7;
		font-size: 12px;
	}
</style>
