<script lang="ts">
	import { onDestroy } from 'svelte';
	import FeIcon from './FeIcon.svelte';
	import { getPreviewKind, renderPdfPageToCanvas } from './feThumbnails.js';
	import type { ExplorerDriver, ExplorerEntry } from './explorerDriver.js';

	let {
		entry,
		driver,
		onClose
	}: {
		entry: ExplorerEntry;
		driver: ExplorerDriver;
		onClose: () => void;
	} = $props();

	let blobUrl = $state<string | null>(null);
	let loading = $state(true);
	let error = $state('');
	let kind = $derived(getPreviewKind(entry));
	let pdfBlob = $state<Blob | null>(null);

	// PDF page state
	let pdfPageCount = $state(0);
	let pdfCurrentPage = $state(0);
	let pdfCanvas = $state<HTMLCanvasElement | null>(null);

	onDestroy(() => {
		revokeUrl();
	});

	function revokeUrl() {
		if (blobUrl) {
			URL.revokeObjectURL(blobUrl);
			blobUrl = null;
		}
	}

	$effect(() => {
		const e = entry;
		const d = driver;
		const k = kind;
		// Captured, not re-read: see FeThumbnail — the narrowing would not
		// survive into the async block below.
		const readBlob = d.readBlob;
		if (!k || !readBlob) {
			loading = false;
			error = 'Preview not available for this file type';
			return;
		}

		let cancelled = false;
		revokeUrl();
		loading = true;
		error = '';
		pdfPageCount = 0;
		pdfCurrentPage = 0;
		pdfBlob = null;

		(async () => {
			try {
				const blob = await readBlob.call(d, e.id);
				if (cancelled || !blob) return;

				if (k === 'pdf') {
					pdfBlob = blob;
					// Wait for canvas to be bound
					await tick();
					if (cancelled || !pdfCanvas) return;
					pdfPageCount = await renderPdfPageToCanvas(pdfCanvas, blob, 0, 1000);
					pdfCurrentPage = 0;
				} else {
					blobUrl = URL.createObjectURL(blob);
				}
				if (!cancelled) loading = false;
			} catch (err) {
				if (!cancelled) {
					error = err instanceof Error ? err.message : 'Failed to load preview';
					loading = false;
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	});

	async function renderPage(pageIdx: number) {
		if (!pdfBlob || !pdfCanvas) return;
		try {
			await renderPdfPageToCanvas(pdfCanvas, pdfBlob, pageIdx, 1000);
			pdfCurrentPage = pageIdx;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to render page';
		}
	}

	function prevPage() {
		if (pdfCurrentPage > 0) void renderPage(pdfCurrentPage - 1);
	}

	function nextPage() {
		if (pdfCurrentPage < pdfPageCount - 1) void renderPage(pdfCurrentPage + 1);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
		if (kind === 'pdf') {
			if (e.key === 'ArrowLeft') prevPage();
			if (e.key === 'ArrowRight') nextPage();
		}
	}

	async function tick() {
		await new Promise((r) => requestAnimationFrame(() => r(null)));
	}
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="fe-float-backdrop" onclick={onClose}>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="fe-float-card" role="dialog" aria-modal="true" aria-label={entry.name} tabindex="-1" onclick={(e) => e.stopPropagation()}>
		<div class="fe-float-header">
			<span class="fe-float-title" title={entry.name}>{entry.name}</span>
			<button type="button" class="fe-float-close" data-testid="fe-float-close" aria-label="Close" onclick={onClose}>
				<FeIcon name="x" size={20} />
			</button>
		</div>
		<div class="fe-float-body">
			{#if loading}
				<div class="fe-float-loading">
					<div class="fe-float-spinner"></div>
				</div>
			{:else if error}
				<div class="fe-float-error">{error}</div>
			{:else if kind === 'image' && blobUrl}
				<img class="fe-float-image" src={blobUrl} alt={entry.name} />
			{:else if kind === 'video' && blobUrl}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video class="fe-float-video" src={blobUrl} controls autoplay playsinline></video>
			{:else if kind === 'pdf'}
				<div class="fe-float-pdf">
					<canvas bind:this={pdfCanvas} class="fe-float-pdf-canvas"></canvas>
					{#if pdfPageCount > 1}
						<div class="fe-float-pdf-nav">
							<button type="button" class="ds-btn ds-btn--sm ds-btn--ghost" onclick={prevPage} disabled={pdfCurrentPage === 0}>
								<FeIcon name="chevron-left" size={16} />
							</button>
							<span class="fe-float-pdf-pager">{pdfCurrentPage + 1} / {pdfPageCount}</span>
							<button type="button" class="ds-btn ds-btn--sm ds-btn--ghost" onclick={nextPage} disabled={pdfCurrentPage >= pdfPageCount - 1}>
								<FeIcon name="chevron-right" size={16} />
							</button>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.fe-float-backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgb(0 0 0 / 0.7);
	}
	.fe-float-card {
		position: relative;
		display: flex;
		flex-direction: column;
		width: min(900px, calc(100vw - 2rem));
		height: min(90vh, 800px);
		background: var(--surface-2, #1a1a1a);
		border: 1px solid var(--line-hairline, #333);
		border-radius: 4px;
		box-shadow: 0 16px 48px rgb(0 0 0 / 0.5);
		overflow: hidden;
	}
	.fe-float-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--line-hairline, #333);
		flex-shrink: 0;
	}
	.fe-float-title {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
		font-size: 0.9rem;
	}
	.fe-float-close {
		flex-shrink: 0;
		background: none;
		border: none;
		color: var(--text-secondary, #aaa);
		cursor: pointer;
		padding: 4px;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.fe-float-close:hover {
		background: var(--surface-3, #2a2a2a);
		color: var(--text-primary, #fff);
	}
	.fe-float-body {
		flex: 1;
		min-height: 0;
		overflow: auto;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.fe-float-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
	}
	.fe-float-spinner {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		border: 3px solid rgb(128 128 128 / 0.2);
		border-top-color: var(--accent, #4a9);
		animation: fe-float-spin 0.7s linear infinite;
	}
	@keyframes fe-float-spin {
		to {
			transform: rotate(360deg);
		}
	}
	.fe-float-error {
		color: var(--cat-red-soft, #e66);
		padding: 24px;
		text-align: center;
	}
	.fe-float-image {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
		display: block;
	}
	.fe-float-video {
		max-width: 100%;
		max-height: 100%;
		display: block;
	}
	.fe-float-pdf {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 12px;
		width: 100%;
		height: 100%;
	}
	.fe-float-pdf-canvas {
		max-width: 100%;
		max-height: calc(100% - 50px);
		object-fit: contain;
		box-shadow: 0 4px 12px rgb(0 0 0 / 0.3);
	}
	.fe-float-pdf-nav {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-shrink: 0;
	}
	.fe-float-pdf-pager {
		font-size: 0.85rem;
		color: var(--text-secondary, #aaa);
		font-variant-numeric: tabular-nums;
		min-width: 60px;
		text-align: center;
	}
</style>
