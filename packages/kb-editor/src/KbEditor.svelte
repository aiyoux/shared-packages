<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { plaintextOf, type Op } from '@shared-packages/kb-model';
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
	import { dropAfterId, dropWhere } from './gutter.js';
	import { mapKeydown } from './keymap.js';
	import { BLOCK_ID_ATTR, project } from './project.js';
	import { rangeFromInputEvent, rangeFromSelection, restoreSelection } from './selection.js';
	import { applyEditorOps, redo, setSelection, undo, type EditorState } from './state.js';

	let {
		state: editor,
		editable = true,
		onDispatch,
		onState = undefined
	}: {
		state: EditorState;
		editable?: boolean;
		/** Single op or a group. Parent should use `applyEditorOps` so groups stay one undo entry. */
		onDispatch: (op: Op | Op[]) => void;
		onState?: (next: EditorState) => void;
	} = $props();

	let host = $state<HTMLDivElement | undefined>(undefined);
	let localComposing = $state(false);
	let localJustCommitted = $state(false);
	let snapshot = $state<CompositionSnapshot | null>(null);
	let heights = $state<number[]>([]);
	let draggingId = $state<string | null>(null);

	const composing = $derived(localComposing || editor.composing);

	function emitState(next: EditorState) {
		onState?.(next);
	}

	function emitOps(ops: Op[]) {
		if (ops.length === 0) return;
		onDispatch(ops.length === 1 ? ops[0] : ops);
	}

	function liveRange(event?: InputEvent) {
		if (!host) return editor.selection;
		if (event) return rangeFromInputEvent(host, event, editor.selection);
		return rangeFromSelection(host) ?? editor.selection;
	}

	$effect(() => {
		const page = editor.page;
		if (!host || composing) return;
		project(host, page);
		untrack(() => {
			restoreSelection(host, editor.selection, page);
			heights = [...host.children].map((el) => (el as HTMLElement).offsetHeight);
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
		emitOps(mapped.ops);
	}

	function onCompositionStart(_event: CompositionEvent) {
		const live = liveRange();
		snapshot = snapshotComposition(editor, live);
		localComposing = true;
		emitState(beginComposition(editor));
	}

	function onCompositionEnd(event: CompositionEvent) {
		localComposing = false;
		const snap = snapshot;
		snapshot = null;
		const snapPage = snap?.page ?? editor.page;
		const snapSel = snap?.selection ?? editor.selection;
		const block = snapPage.blocks.find((item) => item.id === snapSel.anchor.blockId);
		const original = block ? plaintextOf(block) : '';
		let domText: string | null = null;
		if (host) {
			const el = host.querySelector(`[${BLOCK_ID_ATTR}="${snapSel.anchor.blockId}"]`);
			domText = el?.textContent ?? null;
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
		const committed = {
			...applyEditorOps({ ...editor, composing: false }, ops.length === 1 ? ops[0] : ops),
			composing: false,
			justCommittedComposition: true
		};
		if (onState) {
			emitState(committed);
		} else {
			emitOps(ops);
		}
	}

	function onKeyDown(event: KeyboardEvent) {
		const result = mapKeydown(
			{ ...editor, composing },
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
		if (result.history === 'undo') emitState(undo(editor));
		if (result.history === 'redo') emitState(redo(editor));
		emitOps(result.ops);
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
		emitOps(cutOps(live));
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
		if (live) emitState(setSelection(editor, live));
	}

	onMount(() => {
		const doc = host?.ownerDocument ?? document;
		doc.addEventListener('selectionchange', onSelectionChange);
		return () => doc.removeEventListener('selectionchange', onSelectionChange);
	});

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
		const afterId = dropAfterId(editor.page, id, targetId, where);
		if (afterId === 'noop') return;
		onDispatch({ kind: 'move-block', id, afterId });
	}

	function onHandleDragEnd() {
		draggingId = null;
	}
</script>

<div class="kb-editor" data-testid="kb-editor">
	<div class="kb-gutter" contenteditable="false" data-testid="kb-gutter">
		{#each editor.page.blocks as block, i (block.id)}
			<button
				type="button"
				class="kb-handle"
				aria-label="Drag to reorder"
				draggable={editable}
				data-block-id={block.id}
				style:height="{Math.max(heights[i] ?? 24, 24)}px"
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
		flex: 0 0 1.25rem;
		display: flex;
		flex-direction: column;
		user-select: none;
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
</style>
