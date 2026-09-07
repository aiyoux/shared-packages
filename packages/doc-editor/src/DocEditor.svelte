<script lang="ts" generics="TDoc extends DocBody">
	import { onMount, untrack } from 'svelte';
	import {
		findBlock,
		isNonTextual,
		parentIdOf,
		parentOf,
		plaintextOf,
		type DocBody,
		type KbPage,
		type Op,
		type Range
	} from '@shared-packages/doc-model';
	import { mapBeforeInput } from './beforeinput.js';
	import { copyPayload, cutOps, KB_CLIPBOARD_MIME, pasteOps } from './clipboard.js';
	import {
		beginComposition,
		cancelComposition,
		clearJustCommittedLater,
		commitComposition,
		confirmedCompositionText,
		snapshotComposition,
		type CompositionSnapshot
	} from './composition.js';
	import { stripCollabWidgets, type RemoteCaret } from './decorations.js';
	import {
		blockFromPoint,
		dropTarget,
		dropWhere,
		gutterOrder,
		handleBoxes,
		overlayBoxes,
		type HandleBox,
		type OverlayBox
	} from './gutter.js';
	import { mapKeydown } from './keymap.js';
	import { BLOCK_ID_ATTR, project, type MediaResolver } from './project.js';
	import {
		plaintextFromDom,
		rangeFromInputEvent,
		rangeFromSelection,
		restoreSelection,
		focusHeldOutside
	} from './selection.js';
	import { applyEditorOps, redo, setSelection, undo, type EditorState } from './state.js';

	let {
		// Renamed off `state` deliberately: a local binding called `state` makes
		// the compiler read `$state(...)` in this file as a store subscription to
		// it — no build error, `store_invalid_shape` at runtime, component renders
		// nothing.
		state: editor,
		editable = true,
		showHandles = false,
		carets = [],
		media = undefined,
		onDispatch,
		onState = undefined,
		onComposing = undefined,
		onSelection = undefined,
		onKeyDownCapture = undefined,
		onBeforeInputCapture = undefined,
		testIdPrefix = 'kb'
	}: {
		state: EditorState<TDoc>;
		editable?: boolean;
		/**
		 * Whether the gutter's ⋮⋮ drag handles render. Off by default: they are
		 * chrome for reordering, not content, so a host opts in (the KB toolbar
		 * has a toggle for it). Hiding them also disables drag-reordering — the
		 * handles are the drag sources.
		 */
		showHandles?: boolean;
		/** Remote caret widgets. Ignored while composing (IME freeze). */
		carets?: RemoteCaret[];
		/**
		 * Resolves image `src` (e.g. page-relative `assets/<file>` → object URL).
		 * Identity is the repaint signal: keep it stable while resolutions are
		 * unchanged, and hand over a new object once one lands, so an image that
		 * resolves after the first paint actually appears.
		 */
		media?: MediaResolver;
		/** Single op or a group. Parent should use `applyEditorOps` so groups stay one undo entry. */
		onDispatch: (op: Op | Op[]) => void;
		onState?: (next: EditorState<TDoc>) => void;
		onComposing?: (composing: boolean) => void;
		onSelection?: (range: Range) => void;
		/**
		 * Let the host act on a key first. Return `true` to say "handled" and the
		 * editor does nothing further with it.
		 *
		 * This exists for a host-owned overlay — a slash menu, say — whose
		 * Enter/Escape/arrows have to win over the editor's. The alternative was
		 * to move that UI into this component, which would make every consumer
		 * carry one host's menu.
		 */
		onKeyDownCapture?: (event: KeyboardEvent, live: Range) => boolean;
		/** Same seam for `beforeinput`. Return `true` to consume the event. */
		onBeforeInputCapture?: (event: InputEvent, live: Range) => boolean;
		/**
		 * Prefix for this component's `data-testid`s. Two apps mount it and each
		 * has its own e2e vocabulary; hard-coding one host's prefix into a shared
		 * component makes the other's selectors read as someone else's.
		 */
		testIdPrefix?: string;
	} = $props();

	/**
	 * The DOM layer below (`project`, `mapBeforeInput`, `mapKeydown`, the
	 * clipboard and gutter helpers) is typed against `KbPage` because that was
	 * the only envelope this package had. Every one of those functions reads
	 * `blocks` and nothing else — but a record-backed document has no `format`
	 * or `children`, so the two envelopes are structurally incompatible and
	 * TypeScript rejects the call even though it is sound.
	 *
	 * Widening ~40 signatures to `DocBody` cascades through `table.ts` and
	 * `units.ts` and would still leave every KB caller re-narrowing. So the
	 * boundary is here, cast once and named, the same trade `apply`/`invert`
	 * already make internally: public entry points are generic, the internals
	 * keep one concrete envelope. The invariant that makes it safe — nothing
	 * below reads or writes an envelope field — is enforced by
	 * `docBodyState.test.ts`.
	 */
	const asPage = (doc: TDoc): KbPage => doc as unknown as KbPage;
	const asPageState = (s: EditorState<TDoc>): EditorState => ({ ...s, page: asPage(s.page) });

	let host = $state<HTMLDivElement | undefined>(undefined);
	let gutterEl = $state<HTMLDivElement | undefined>(undefined);
	let localComposing = $state(false);
	let localJustCommitted = $state(false);
	let snapshot = $state<CompositionSnapshot<TDoc> | null>(null);
	let handleBoxById = $state<Record<string, HandleBox>>({});
	let overlays = $state<OverlayBox[]>([]);
	let draggingId = $state<string | null>(null);
	/** Live move-drop candidate. Plain fields, never `$state`: dragover paints
	 *  on the DOM directly, same rule as the design-system tree drag. */
	let moveDrop: { id: string; where: 'before' | 'after' } | null = null;
	let dropLineEl = $state<HTMLDivElement | undefined>(undefined);

	const composing = $derived(localComposing || editor.composing);

	function emitState(next: EditorState) {
		onState?.(next);
	}

	function emitOps(ops: Op[]) {
		if (ops.length === 0) return;
		onDispatch(ops.length === 1 ? ops[0] : ops);
	}

	function emitMapped(ops: Op[], selection?: Range) {
		if (ops.length) emitOps(ops);
		if (!selection) return;
		const next = ops.length
			? setSelection(applyEditorOps(editor, ops), selection)
			: setSelection(editor, selection);
		emitState(next);
		if (host) {
			if (ops.length) project(host, asPage(next.page), { media });
			restoreSelection(host, next.selection, asPage(next.page));
		}
	}

	function liveRange(event?: InputEvent) {
		if (!host) return editor.selection;
		if (event) return rangeFromInputEvent(host, event, editor.selection);
		return rangeFromSelection(host) ?? editor.selection;
	}

	function syncTableHeights(host: HTMLElement) {
		const rowGroups = new Map<string, HTMLElement[]>();
		for (const child of host.children) {
			const el = child as HTMLElement;
			if (el.getAttribute('data-block-type') === 'table_cell') {
				const parentId = el.getAttribute('data-parent-id');
				if (parentId) {
					const group = rowGroups.get(parentId);
					if (group) group.push(el);
					else rowGroups.set(parentId, [el]);
				}
			}
		}
		for (const [, cells] of rowGroups) {
			for (const cell of cells) cell.style.minHeight = '';
			let maxH = 0;
			for (const cell of cells) {
				if (cell.offsetHeight > maxH) maxH = cell.offsetHeight;
			}
			if (maxH > 0) {
				for (const cell of cells) cell.style.minHeight = `${maxH}px`;
			}
		}
	}

	/**
	 * What `project()` last painted, and whether the DOM still matches it.
	 *
	 * `project()` rebuilds every block element, and this effect re-runs far more
	 * often than the document changes — measured at ~350 full block-list
	 * rebuilds/second on an idle solo page and ~1500/s in a live session, with
	 * nothing happening. Every `<p>` was destroyed and recreated each time, so
	 * clicking a block raced its own teardown.
	 *
	 * Page identity alone is NOT a sufficient guard, because three paths change
	 * the DOM without changing the page:
	 *   - while composing, beforeinput deliberately never preventDefaults, so
	 *     the browser writes IME text straight into the text nodes
	 *   - `stripCollabWidgets` removes remote carets from the DOM
	 *   - the composition-cancel path calls `project()` itself
	 * After any of those the DOM has diverged from `paintedPage` and must be
	 * re-projected even though the model is unchanged. `domDiverged` records
	 * that, so the guard reflects what is actually on screen rather than a
	 * guess. Plain `let`, not `$state`: marking divergence must not itself
	 * schedule a repaint — the next real update reconciles it.
	 */
	let paintedPage: KbPage | undefined;
	let paintedCaretKey = '';
	let paintedMedia: MediaResolver | undefined;
	let domDiverged = true;

	/** Carets arrive as a fresh array each render, so compare by content. */
	function caretKey(list: RemoteCaret[]): string {
		let out = '';
		for (const c of list) {
			out += `${c.clientId}:${c.anchor.blockId}:${c.anchor.offset}:${c.head.blockId}:${c.head.offset}:${c.user.color}|`;
		}
		return out;
	}

	$effect(() => {
		const page = asPage(editor.page);
		const remoteCarets = carets;
		const el = host;
		if (!el) return;
		if (composing) {
			stripCollabWidgets(el);
			domDiverged = true;
			return;
		}
		const key = caretKey(remoteCarets);
		if (domDiverged || page !== paintedPage || key !== paintedCaretKey || media !== paintedMedia) {
			project(el, page, { carets: remoteCarets, media });
			syncTableHeights(el);
			paintedPage = page;
			paintedCaretKey = key;
			paintedMedia = media;
			domDiverged = false;
		}
		untrack(() => {
			// A repaint must not pull focus out of a text field elsewhere in the
			// app; see `focusHeldOutside`.
			if (!focusHeldOutside(el)) restoreSelection(el, editor.selection, page);
			handleBoxById = Object.fromEntries(
				handleBoxes(el, page, gutterEl).map((box) => [box.id, box])
			);
			overlays = overlayBoxes(el, gutterEl);
		});
	});

	function onBeforeInput(event: InputEvent) {
		if (onBeforeInputCapture?.(event, liveRange())) return;
		const frozen = composing || event.isComposing;
		if (frozen) return;

		const live = liveRange(event);
		const mapped = mapBeforeInput(
			{
				...asPageState(editor),
				composing: false,
				justCommittedComposition: localJustCommitted || editor.justCommittedComposition
			},
			{ inputType: event.inputType, data: event.data, isComposing: event.isComposing },
			live
		);

		if (mapped.preventDefault) event.preventDefault();
		// Not prevented means the browser edits the DOM itself, so whatever is
		// on screen no longer matches what we last painted.
		else domDiverged = true;
		if (mapped.history === 'undo') {
			emitState(undo(editor));
			return;
		}
		if (mapped.history === 'redo') {
			emitState(redo(editor));
			return;
		}
		emitMapped(mapped.ops, mapped.selection);
	}

	function onCompositionStart(_event: CompositionEvent) {
		const live = liveRange();
		snapshot = snapshotComposition(editor, live);
		localComposing = true;
		domDiverged = true;
		onComposing?.(true);
		emitState(beginComposition(editor));
	}

	function onCompositionEnd(event: CompositionEvent) {
		localComposing = false;
		domDiverged = true;
		onComposing?.(false);
		const snap = snapshot;
		snapshot = null;
		const snapPage = asPage(snap?.page ?? editor.page);
		const snapSel = snap?.selection ?? editor.selection;
		const block = findBlock(snapPage, snapSel.anchor.blockId);
		const original = block ? plaintextOf(block) : '';
		let domText: string | null = null;
		if (host) {
			const el = host.querySelector(`[${BLOCK_ID_ATTR}="${snapSel.anchor.blockId}"]`);
			domText = el ? plaintextFromDom(el as HTMLElement) : null;
		}
		const data = confirmedCompositionText({ data: event.data }, domText, original);
		if (!data) {
			emitState(cancelComposition(editor));
			if (host) {
				project(host, snapPage, { media });
				restoreSelection(host, snapSel, snapPage);
			}
			return;
		}
		const { ops } = commitComposition(
			editor,
			{ page: snap?.page ?? editor.page, selection: snapSel },
			data
		);
		localJustCommitted = true;
		clearJustCommittedLater(() => {
			localJustCommitted = false;
		});
		emitOps(ops);
	}

	function onKeyDown(event: KeyboardEvent) {
		if (onKeyDownCapture?.(event, liveRange())) return;
		const result = mapKeydown(
			{
				...asPageState(editor),
				composing,
				justCommittedComposition: localJustCommitted || editor.justCommittedComposition
			},
			{
				key: event.key,
				metaKey: event.metaKey,
				ctrlKey: event.ctrlKey,
				shiftKey: event.shiftKey,
				altKey: event.altKey
			},
			liveRange()
		);
		if (result.preventDefault) event.preventDefault();
		if (result.history === 'undo') {
			emitState(undo(editor));
			return;
		}
		if (result.history === 'redo') {
			emitState(redo(editor));
			return;
		}
		emitMapped(result.ops, result.selection);
	}

	function onCopy(event: ClipboardEvent) {
		if (composing) return;
		const live = liveRange();
		const payload = copyPayload(asPageState(editor), live);
		if (!payload || !event.clipboardData) return;
		event.preventDefault();
		event.clipboardData.setData('text/plain', payload.plain);
		event.clipboardData.setData(KB_CLIPBOARD_MIME, payload.json);
	}

	function onCut(event: ClipboardEvent) {
		if (composing) return;
		const live = liveRange();
		const payload = copyPayload(asPageState(editor), live);
		if (!payload || !event.clipboardData) return;
		event.preventDefault();
		event.clipboardData.setData('text/plain', payload.plain);
		event.clipboardData.setData(KB_CLIPBOARD_MIME, payload.json);
		emitOps(cutOps(asPage(editor.page), live, editor.blockFocus));
	}

	function onPaste(event: ClipboardEvent) {
		if (composing) return;
		event.preventDefault();
		const live = liveRange();
		const data = event.clipboardData;
		emitOps(
			pasteOps(asPageState(editor), live, {
				json: data?.getData(KB_CLIPBOARD_MIME) || null,
				html: data?.getData('text/html') || null,
				plain: data?.getData('text/plain') || null
			})
		);
	}

	/**
	 * While one of our handles drags, the whole host is the drop surface: the
	 * hovered block becomes the target (nearest block wins, so gaps and
	 * margins never dead-zone), and a 2px line paints where the block will
	 * land. Painting is plain DOM — `blockFromPoint` + a classless line
	 * element, no `$state` — so dragover never re-renders the editor.
	 */
	function paintMoveDrop(clientY: number) {
		if (!host || !dropLineEl || !draggingId) return;
		const hit = blockFromPoint(host, asPage(editor.page), clientY, draggingId);
		const drop = hit ? dropTarget(asPage(editor.page), draggingId, hit.id, hit.where) : 'noop';
		if (!hit || drop === 'noop') {
			moveDrop = null;
			dropLineEl.hidden = true;
			return;
		}
		moveDrop = { id: hit.id, where: hit.where };
		const editorTop = dropLineEl.parentElement?.getBoundingClientRect().top ?? 0;
		dropLineEl.style.top = `${Math.max(0, (hit.where === 'before' ? hit.rect.top : hit.rect.bottom - 2) - editorTop)}px`;
		dropLineEl.hidden = false;
	}

	function clearMoveDrop() {
		moveDrop = null;
		if (dropLineEl) dropLineEl.hidden = true;
	}

	function dispatchMove(id: string, hit: { id: string; where: 'before' | 'after' }) {
		const drop = dropTarget(asPage(editor.page), id, hit.id, hit.where);
		if (drop === 'noop') return;
		onDispatch({ kind: 'move-block', id, afterId: drop.afterId, parentId: drop.parentId });
	}

	function onHostDragOver(event: DragEvent) {
		if (composing) return;
		if (draggingId) {
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
			paintMoveDrop(event.clientY);
			return;
		}
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
	}

	function onHostDrop(event: DragEvent) {
		if (composing) return;
		if (draggingId) {
			event.preventDefault();
			const id = draggingId;
			const hit = moveDrop;
			draggingId = null;
			clearMoveDrop();
			if (!id || !hit) return;
			dispatchMove(id, hit);
			return;
		}
		event.preventDefault();
		const live = liveRange();
		const data = event.dataTransfer;
		emitOps(
			pasteOps(asPageState(editor), live, {
				json: data?.getData(KB_CLIPBOARD_MIME) || null,
				html: data?.getData('text/html') || null,
				plain: data?.getData('text/plain') || null
			})
		);
	}

	function onSelectionChange() {
		if (composing || !host) return;
		const sel = host.ownerDocument.getSelection();
		if (!sel?.anchorNode || !host.contains(sel.anchorNode)) return;
		const live = rangeFromSelection(host, sel);
		if (live) {
			emitState(setSelection(editor, live));
			onSelection?.(live);
		}
	}

	onMount(() => {
		const doc = host?.ownerDocument ?? document;
		doc.addEventListener('selectionchange', onSelectionChange);
		return () => doc.removeEventListener('selectionchange', onSelectionChange);
	});

	function onHandlePointerDown(id: string) {
		if (composing || !editable) return;
		const block = findBlock(editor.page, id);
		if (block && isNonTextual(block)) {
			emitState(setSelection(editor, { anchor: { blockId: id, offset: 0 }, head: { blockId: id, offset: 0 } }));
		}
	}

	function onHandleDragStart(event: DragEvent, id: string) {
		draggingId = id;
		event.dataTransfer?.setData('text/plain', id);
		if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
	}

	function onHandleDragOver(event: DragEvent) {
		if (!draggingId) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		paintMoveDrop(event.clientY);
	}

	function onHandleDrop(event: DragEvent, targetId: string) {
		event.preventDefault();
		const id = draggingId;
		draggingId = null;
		clearMoveDrop();
		if (!id) return;
		const target = event.currentTarget as HTMLElement;
		const where = dropWhere(event.clientY, target.getBoundingClientRect());
		dispatchMove(id, { id: targetId, where });
	}

	function onHostClick(event: MouseEvent) {
		if (composing || !editable || !host) return;
		const target = event.target as HTMLElement | null;
		const el = target?.closest?.('[data-block-id]') as HTMLElement | null;
		if (!el || !host.contains(el) || el.getAttribute('data-block-type') !== 'toggle') return;
		const id = el.getAttribute('data-block-id');
		if (!id) return;
		const block = findBlock(editor.page, id);
		if (block?.type !== 'toggle') return;
		onDispatch({ kind: 'set-toggle', id, open: !block.open });
	}

	function handleParentId(blockId: string): string | undefined {
		const loc = parentOf(editor.page, blockId);
		if (!loc || loc.parent === 'page') return undefined;
		return parentIdOf(loc.parent) ?? undefined;
	}

	function onHandleDragEnd() {
		draggingId = null;
		clearMoveDrop();
	}
</script>

<div class="kb-editor" data-testid={`${testIdPrefix}-editor`}>
	<div class="kb-gutter" bind:this={gutterEl} contenteditable="false" data-testid={`${testIdPrefix}-gutter`}>
		{#each overlays as box (box.parentId)}
			<div
				class="kb-overlay"
				data-testid={`${testIdPrefix}-gutter-overlay`}
				data-parent-id={box.parentId}
				style:top="{box.top}px"
				style:height="{Math.max(box.height, 0)}px"
				style:pointer-events="none"
			></div>
		{/each}
		{#if showHandles}
			{#each gutterOrder(asPage(editor.page)) as block (block.id)}
				<button
					type="button"
					class="kb-handle"
					class:dnd-dragging={draggingId === block.id}
					aria-label="Drag to reorder"
					draggable={editable}
					data-block-id={block.id}
					data-parent-id={handleParentId(block.id)}
					style:top="{handleBoxById[block.id]?.top ?? 0}px"
					style:height="{handleBoxById[block.id]?.height ?? 24}px"
					onpointerdown={() => onHandlePointerDown(block.id)}
					ondragstart={(e) => onHandleDragStart(e, block.id)}
					ondragover={onHandleDragOver}
					ondrop={(e) => onHandleDrop(e, block.id)}
					ondragend={onHandleDragEnd}
				></button>
			{/each}
		{/if}
	</div>
	<div
		class="kb-host"
		bind:this={host}
		contenteditable={editable ? 'true' : 'false'}
		role="textbox"
		tabindex="0"
		aria-multiline="true"
		aria-readonly={editable ? undefined : 'true'}
		data-testid={`${testIdPrefix}-host`}
		spellcheck="true"
		onbeforeinput={onBeforeInput}
		oncompositionstart={onCompositionStart}
		oncompositionend={onCompositionEnd}
		onkeydown={onKeyDown}
		oncopy={onCopy}
		oncut={onCut}
		onpaste={onPaste}
		ondragover={onHostDragOver}
		ondrop={onHostDrop}
		onclick={onHostClick}
	></div>
	<!-- Move-drop indicator: painted during a handle drag, positioned over the
	     landing edge of the hovered block. Plain DOM, hidden between drags. -->
	<div class="kb-drop-line" bind:this={dropLineEl} hidden></div>
</div>

<style>
	.kb-editor {
		/* Relative: the move-drop line positions against the editor box. */
		position: relative;
		display: flex;
		flex-direction: row;
		align-items: stretch;
		gap: 0.25rem;
		width: 100%;
	}
	.kb-gutter {
		position: relative;
		flex: 0 0 1.25rem;
		width: 1.25rem;
		display: flex;
		flex-direction: column;
		user-select: none;
	}
	.kb-overlay {
		position: absolute;
		left: 0;
		width: 100%;
		max-width: 100%;
		pointer-events: none;
		box-sizing: border-box;
		border-left: 3px solid currentColor;
		opacity: 0.4;
	}
	/* Handles are absolutely positioned onto their block's measured box
	   (`handleBoxes`), so the dots sit vertically centred on the content they
	   move — margin gaps belong to no handle. */
	.kb-handle {
		display: block;
		width: 100%;
		padding: 0;
		margin: 0;
		border: 0;
		background: transparent;
		cursor: grab;
		position: absolute;
		left: 0;
		z-index: 1;
		pointer-events: auto;
	}
	.kb-handle::before {
		content: '⋮⋮';
		position: absolute;
		left: 0;
		top: 50%;
		transform: translateY(-50%);
		font-size: 0.7rem;
		line-height: 1;
		opacity: 0.75;
		color: var(--text-secondary, currentColor);
	}
	.kb-handle:hover::before,
	.kb-handle:active::before {
		opacity: 1;
		color: var(--text-primary, currentColor);
	}
	.kb-handle:active {
		cursor: grabbing;
	}
	/* The block being dragged dims, like the tree's .dnd-dragging row. */
	.kb-handle.dnd-dragging {
		opacity: 0.3;
	}
	.kb-drop-line {
		position: absolute;
		/* From the gutter's right edge across the content column. */
		left: 1.5rem;
		right: 0;
		height: 2px;
		border-radius: 1px;
		background: var(--accent);
		pointer-events: none;
		z-index: 2;
	}
	.kb-drop-line[hidden] {
		display: none;
	}
	.kb-host {
		flex: 1 1 auto;
		min-width: 0;
		outline: none;
		white-space: pre-wrap;
		word-wrap: break-word;
	}
	/* An empty text block must still be clickable. With no content, `<p>` and
	   friends collapse to zero height, so the caret cannot be placed in them —
	   the first paragraph of a new page being the obvious case. Structural and
	   atomic blocks (divider, image, table parts) are left alone: they have
	   their own sizing. */
	.kb-host :global([data-block-type='paragraph']),
	.kb-host :global([data-block-type='heading']),
	.kb-host :global([data-block-type='list_item']),
	.kb-host :global([data-block-type='code']),
	.kb-host :global([data-block-type='table_cell']) {
		min-height: 1.25em;
	}
	.kb-host :global([data-block-type='paragraph']) {
		margin: 0 0 0.5rem;
	}
	.kb-host :global([data-block-type='heading']) {
		margin: 0.75rem 0 0.4rem;
		font-weight: 650;
	}
	.kb-host :global(h1) {
		font-size: 1.6rem;
	}
	.kb-host :global(h2) {
		font-size: 1.3rem;
	}
	.kb-host :global(h3) {
		font-size: 1.1rem;
	}
	.kb-host :global([data-block-type='list_item']) {
		display: list-item;
		list-style-position: outside;
		margin: 0 0 0.15rem 1.5rem;
	}
	.kb-host :global([data-block-type='list_item'][data-ordered='false']) {
		list-style-type: disc;
	}
	.kb-host :global([data-block-type='list_item'][data-ordered='true']) {
		list-style-type: none;
		counter-increment: kb-ol;
	}
	.kb-host :global([data-block-type='list_item'][data-ordered='true'])::before {
		content: counter(kb-ol) '. ';
		margin-left: -1.5rem;
		width: 1.25rem;
		display: inline-block;
		text-align: right;
	}
	.kb-host {
		counter-reset: kb-ol;
	}
	.kb-host :global(:not([data-ordered='true']) + [data-ordered='true']) {
		counter-reset: kb-ol;
		counter-increment: kb-ol;
	}
	.kb-host :global([data-block-type='code']) {
		margin: 0.5rem 0;
		padding: 0.5rem 0.75rem;
		background: rgba(127, 127, 127, 0.12);
		border-radius: 0.25rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		white-space: pre-wrap;
	}
	.kb-host :global([data-block-type='divider']) {
		margin: 0.75rem 0;
		border: 0;
		border-top: 1px solid currentColor;
		opacity: 0.3;
	}
	/* Block types this build does not model: shown as an opaque placeholder so the
	   document stays legible and the foreign JSON survives an edit + save. */
	.kb-host :global([data-unknown-type]) {
		margin: 0.5rem 0;
		min-height: 1.5rem;
		padding: 0.4rem 0.6rem;
		border: 1px dashed currentColor;
		border-radius: 0.25rem;
		opacity: 0.6;
		user-select: none;
	}
	.kb-host :global([data-unknown-type])::before {
		content: '\2b1a\a0' attr(data-unknown-type);
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.85em;
	}
	.kb-host :global(code) {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.9em;
	}
	.kb-host::after {
		content: '';
		display: table;
		clear: both;
	}
	.kb-host :global([data-block-type='callout']),
	.kb-host :global([data-block-type='toggle']) {
		margin: 0;
		min-height: 24px;
		height: 24px;
		box-sizing: border-box;
	}
	.kb-host :global([data-block-type='table']) {
		margin: 0.5rem 0 0;
		height: 0;
		min-height: 0;
		clear: both;
	}
	.kb-host :global([data-block-type='table_cell']) {
		display: inline-block;
		float: left;
		margin: 0;
		padding: 0.4rem 0.65rem;
		min-height: 2.25rem;
		border-right: 1px solid color-mix(in srgb, currentColor 28%, transparent);
		border-bottom: 1px solid color-mix(in srgb, currentColor 28%, transparent);
		box-sizing: border-box;
		word-break: break-word;
	}
	.kb-host :global([data-block-type='table_cell'][data-col='0']) {
		clear: left;
		border-left: 1px solid color-mix(in srgb, currentColor 28%, transparent);
	}
	.kb-host :global([data-block-type='table_cell'][data-row='0']) {
		border-top: 1px solid color-mix(in srgb, currentColor 28%, transparent);
	}
	.kb-host :global([data-block-type='table_cell'][data-header='true']) {
		font-weight: 650;
		background: color-mix(in srgb, currentColor 6%, transparent);
	}
	.kb-host :global(> :not([data-block-type='table_cell'])) {
		clear: both;
	}
	.kb-host :global([data-depth='1']:not([data-block-type='table_cell'])) {
		margin-left: 0.75rem;
	}
</style>
