<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import {
		findBlock,
		isNonTextual,
		parentIdOf,
		parentOf,
		plaintextOf,
		type Op,
		type Range
	} from '@shared-packages/kb-model';
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
	import { dropTarget, dropWhere, gutterOrder, handleHeights, overlayBoxes, type OverlayBox } from './gutter.js';
	import { mapKeydown } from './keymap.js';
	import { BLOCK_ID_ATTR, project } from './project.js';
	import {
		plaintextFromDom,
		rangeFromInputEvent,
		rangeFromSelection,
		restoreSelection
	} from './selection.js';
	import { applyEditorOps, redo, setSelection, undo, type EditorState } from './state.js';

	let {
		state: editor,
		editable = true,
		carets = [],
		onDispatch,
		onState = undefined,
		onComposing = undefined,
		onSelection = undefined
	}: {
		state: EditorState;
		editable?: boolean;
		/** Remote caret widgets. Ignored while composing (IME freeze). */
		carets?: RemoteCaret[];
		/** Single op or a group. Parent should use `applyEditorOps` so groups stay one undo entry. */
		onDispatch: (op: Op | Op[]) => void;
		onState?: (next: EditorState) => void;
		onComposing?: (composing: boolean) => void;
		onSelection?: (range: Range) => void;
	} = $props();

	let host = $state<HTMLDivElement | undefined>(undefined);
	let gutterEl = $state<HTMLDivElement | undefined>(undefined);
	let localComposing = $state(false);
	let localJustCommitted = $state(false);
	let snapshot = $state<CompositionSnapshot | null>(null);
	let heightById = $state<Record<string, number>>({});
	let overlays = $state<OverlayBox[]>([]);
	let draggingId = $state<string | null>(null);

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
			if (ops.length) project(host, next.page);
			restoreSelection(host, next.selection, next.page);
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

	$effect(() => {
		const page = editor.page;
		const remoteCarets = carets;
		if (!host) return;
		if (composing) {
			stripCollabWidgets(host);
			return;
		}
		project(host, page, { carets: remoteCarets });
		syncTableHeights(host);
		untrack(() => {
			restoreSelection(host, editor.selection, page);
			heightById = handleHeights(host, page);
			overlays = overlayBoxes(host, gutterEl);
		});
	});

	function onBeforeInput(event: InputEvent) {
		const frozen = composing || event.isComposing;
		if (frozen) return;

		const live = liveRange(event);
		const mapped = mapBeforeInput(
			{
				...editor,
				composing: false,
				justCommittedComposition: localJustCommitted || editor.justCommittedComposition
			},
			{ inputType: event.inputType, data: event.data, isComposing: event.isComposing },
			live
		);

		if (mapped.preventDefault) event.preventDefault();
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
		onComposing?.(true);
		emitState(beginComposition(editor));
	}

	function onCompositionEnd(event: CompositionEvent) {
		localComposing = false;
		onComposing?.(false);
		const snap = snapshot;
		snapshot = null;
		const snapPage = snap?.page ?? editor.page;
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
				project(host, snapPage);
				restoreSelection(host, snapSel, snapPage);
			}
			return;
		}
		const { ops } = commitComposition(editor, { page: snapPage, selection: snapSel }, data);
		localJustCommitted = true;
		clearJustCommittedLater(() => {
			localJustCommitted = false;
		});
		emitOps(ops);
	}

	function onKeyDown(event: KeyboardEvent) {
		const result = mapKeydown(
			{
				...editor,
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
		const payload = copyPayload(editor, live);
		if (!payload || !event.clipboardData) return;
		event.preventDefault();
		event.clipboardData.setData('text/plain', payload.plain);
		event.clipboardData.setData(KB_CLIPBOARD_MIME, payload.json);
	}

	function onCut(event: ClipboardEvent) {
		if (composing) return;
		const live = liveRange();
		const payload = copyPayload(editor, live);
		if (!payload || !event.clipboardData) return;
		event.preventDefault();
		event.clipboardData.setData('text/plain', payload.plain);
		event.clipboardData.setData(KB_CLIPBOARD_MIME, payload.json);
		emitOps(cutOps(editor.page, live, editor.blockFocus));
	}

	function onPaste(event: ClipboardEvent) {
		if (composing) return;
		event.preventDefault();
		const live = liveRange();
		const data = event.clipboardData;
		emitOps(
			pasteOps(editor, live, {
				json: data?.getData(KB_CLIPBOARD_MIME) || null,
				html: data?.getData('text/html') || null,
				plain: data?.getData('text/plain') || null
			})
		);
	}

	function onHostDragOver(event: DragEvent) {
		if (composing) return;
		if (draggingId) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
	}

	function onHostDrop(event: DragEvent) {
		if (composing) return;
		if (draggingId) return;
		event.preventDefault();
		const live = liveRange();
		const data = event.dataTransfer;
		emitOps(
			pasteOps(editor, live, {
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
	}

	function onHandleDrop(event: DragEvent, targetId: string) {
		event.preventDefault();
		const id = draggingId;
		draggingId = null;
		if (!id) return;
		const target = event.currentTarget as HTMLElement;
		const where = dropWhere(event.clientY, target.getBoundingClientRect());
		const drop = dropTarget(editor.page, id, targetId, where);
		if (drop === 'noop') return;
		onDispatch({ kind: 'move-block', id, afterId: drop.afterId, parentId: drop.parentId });
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
	}
</script>

<div class="kb-editor" data-testid="kb-editor">
	<div class="kb-gutter" bind:this={gutterEl} contenteditable="false" data-testid="kb-gutter">
		{#each overlays as box (box.parentId)}
			<div
				class="kb-overlay"
				data-testid="kb-gutter-overlay"
				data-parent-id={box.parentId}
				style:top="{box.top}px"
				style:height="{Math.max(box.height, 0)}px"
				style:pointer-events="none"
			></div>
		{/each}
		{#each gutterOrder(editor.page) as block (block.id)}
			<button
				type="button"
				class="kb-handle"
				aria-label="Drag to reorder"
				draggable={editable}
				data-block-id={block.id}
				data-parent-id={handleParentId(block.id)}
				style:height="{heightById[block.id] ?? 24}px"
				onpointerdown={() => onHandlePointerDown(block.id)}
				ondragstart={(e) => onHandleDragStart(e, block.id)}
				ondragover={onHandleDragOver}
				ondrop={(e) => onHandleDrop(e, block.id)}
				ondragend={onHandleDragEnd}
			></button>
		{/each}
	</div>
	<div
		class="kb-host"
		bind:this={host}
		contenteditable={editable ? 'true' : 'false'}
		role="textbox"
		tabindex="0"
		aria-multiline="true"
		aria-readonly={editable ? undefined : 'true'}
		data-testid="kb-host"
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
</div>

<style>
	.kb-editor {
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
	.kb-handle {
		display: block;
		width: 100%;
		padding: 0;
		margin: 0;
		border: 0;
		background: transparent;
		cursor: grab;
		position: relative;
		z-index: 1;
		pointer-events: auto;
		flex: 0 0 auto;
	}
	.kb-handle::before {
		content: '⋮⋮';
		position: absolute;
		left: 0;
		top: 0.15rem;
		font-size: 0.7rem;
		line-height: 1;
		opacity: 0.35;
	}
	.kb-handle:active {
		cursor: grabbing;
	}
	.kb-host {
		flex: 1 1 auto;
		min-width: 0;
		outline: none;
		white-space: pre-wrap;
		word-wrap: break-word;
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
