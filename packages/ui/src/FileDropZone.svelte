<script lang="ts">
	import { parseExplorerDropPayload, type ExplorerDropPayload } from './explorer-drop.ts';

	let {
		hint = 'Click or drag files here',
		dragHint = 'Drop files here',
		multiple = true,
		accept = '',
		testId = 'file-drop-zone',
		inputTestId = 'file-input',
		onfiles,
		onExplorerIds,
		idle
	}: {
		hint?: string;
		dragHint?: string;
		multiple?: boolean;
		accept?: string;
		testId?: string;
		inputTestId?: string;
		onfiles: (files: File[]) => void;
		/** File Explorer row ids (application/x-fe-explorer-ids) from another pane. */
		onExplorerIds?: (payload: ExplorerDropPayload) => void;
		idle?: import('svelte').Snippet;
	} = $props();

	const EXPLORER_ID_TYPES = [
		'application/x-fe-explorer-ids',
		'application/x-cm-explorer-ids'
	];

	let dragOver = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);
	let suppressClick = $state(false);

	function hasOsFiles(dt: DataTransfer | null | undefined): boolean {
		if (!dt) return false;
		if (dt.files && dt.files.length > 0) return true;
		return Array.from(dt.types ?? []).includes('Files');
	}

	function hasExplorerMime(dt: DataTransfer | null | undefined): boolean {
		if (!dt) return false;
		const types = Array.from(dt.types ?? []);
		return EXPLORER_ID_TYPES.some((t) => types.includes(t));
	}

	function hasExplorerIds(dt: DataTransfer | null | undefined): boolean {
		if (!dt || !onExplorerIds) return false;
		if (hasExplorerMime(dt)) return true;
		const types = Array.from(dt.types ?? []);
		// File Explorer also writes text/plain ids; Chrome may only advertise that
		// type while the drag is over another pane.
		return types.includes('text/plain') && !types.includes('Files');
	}

	function readExplorerPayload(dt: DataTransfer | null | undefined): {
		driverId?: string;
		ids: string[];
	} {
		if (!dt) return { ids: [] };
		let raw = '';
		try {
			raw =
				dt.getData('application/x-fe-explorer-ids') ||
				dt.getData('application/x-cm-explorer-ids') ||
				dt.getData('text/plain') ||
				'';
		} catch {
			raw = '';
		}
		return parseExplorerDropPayload(raw);
	}

	function allowDrop(e: DragEvent) {
		if (!hasOsFiles(e.dataTransfer) && !hasExplorerIds(e.dataTransfer)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		dragOver = true;
	}

	function emit(list: FileList | File[] | null) {
		if (!list || list.length === 0) return;
		onfiles(Array.from(list));
	}

	function emitExplorerIds(e: DragEvent) {
		if (!onExplorerIds) return false;
		const parsed = readExplorerPayload(e.dataTransfer);
		if (!parsed.ids.length) return false;
		onExplorerIds({
			driverId: parsed.driverId,
			ids: parsed.ids,
			clientX: e.clientX,
			clientY: e.clientY
		});
		return true;
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		suppressClick = true;
		// Explorer identity wins even when supportsDragOut also attached File clones.
		if (hasExplorerMime(e.dataTransfer) && onExplorerIds) {
			emitExplorerIds(e);
			return;
		}
		const os = e.dataTransfer?.files?.length ? Array.from(e.dataTransfer.files) : [];
		if (os.length) {
			onfiles(os);
			return;
		}
		emitExplorerIds(e);
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="file-drop-zone"
	class:drag-over={dragOver}
	data-testid={testId}
	ondragenter={allowDrop}
	ondragover={allowDrop}
	ondragleave={(e) => {
		const next = e.relatedTarget;
		if (next instanceof Node && e.currentTarget.contains(next)) return;
		dragOver = false;
	}}
	ondrop={onDrop}
	onclick={() => {
		if (suppressClick) {
			suppressClick = false;
			return;
		}
		fileInput?.click();
	}}
	role="button"
	tabindex="0"
	onkeydown={(e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			fileInput?.click();
		}
	}}
>
	<input
		type="file"
		{multiple}
		{accept}
		bind:this={fileInput}
		onchange={(e) => {
			emit((e.currentTarget as HTMLInputElement).files);
			(e.currentTarget as HTMLInputElement).value = '';
		}}
		hidden
		data-testid={inputTestId}
	/>
	<div class="file-drop-zone-content">
		{#if dragOver}
			<span class="file-drop-zone-icon" aria-hidden="true">📥</span>
			<p>{dragHint}</p>
		{:else}
			<span class="file-drop-zone-icon">
				{#if idle}
					{@render idle()}
				{:else}
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="28"
						height="28"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
						<path d="M14 2v4a2 2 0 0 0 2 2h4" />
						<path d="M12 12v6" />
						<path d="m15 15-3-3-3 3" />
					</svg>
				{/if}
			</span>
			<p>{hint}</p>
		{/if}
	</div>
</div>

<style>
	.file-drop-zone {
		border: 2px dashed var(--border, rgba(255, 255, 255, 0.08));
		border-radius: var(--radius-lg, 16px);
		padding: 40px 24px;
		text-align: center;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			transform 0.15s ease;
		background: var(--bg-card, rgba(255, 255, 255, 0.02));
	}

	.file-drop-zone:hover {
		border-color: var(--accent, #0ea5e9);
		background: var(--bg-card-hover, rgba(255, 255, 255, 0.05));
	}

	.file-drop-zone.drag-over {
		border-color: var(--accent, #0ea5e9);
		background: rgba(var(--accent-rgb, 14, 165, 233), 0.1);
		transform: scale(1.01);
	}

	.file-drop-zone:focus-visible {
		outline: 2px solid var(--accent-light, #38bdf8);
		outline-offset: 2px;
	}

	.file-drop-zone-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
	}

	.file-drop-zone-icon {
		display: inline-flex;
		color: var(--accent-light, #38bdf8);
		opacity: 0.9;
	}

	.file-drop-zone-content p {
		margin: 0;
		color: var(--text-secondary, #94a3b8);
		font-size: 0.95rem;
	}
</style>
