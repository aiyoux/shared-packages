<script lang="ts">
	import { onDestroy, tick, untrack, type Snippet } from 'svelte';
	import FeIcon from './FeIcon.svelte';
	import {
		coerceMediaBlob,
		getPreviewKind,
		renderPdfPageToCanvas
	} from './feThumbnails.js';
	import FeTextPreview from './FeTextPreview.svelte';
	import type { ExplorerDriver, ExplorerEntry } from './explorerDriver.js';
	import {
		canReadExplorerBlob,
		loadExplorerMediaSrc,
		readExplorerBlob,
		type MediaMetaTarget
	} from './explorerDriver.js';
	import { formatPreviewReadError } from './explorerError.js';
	import { PanZoomViewport } from '@shared-packages/ui';

	let {
		entry,
		driver,
		onClose,
		mediaMeta
	}: {
		entry: ExplorerEntry;
		driver: ExplorerDriver;
		onClose: () => void;
		/** Metadata panel for video / GIF previews — same slot as the docked preview. */
		mediaMeta?: Snippet<[MediaMetaTarget]>;
	} = $props();

	let blobUrl = $state<string | null>(null);
	let loading = $state(true);
	let error = $state('');
	let kind = $derived(getPreviewKind(entry));
	let pdfBlob = $state<Blob | null>(null);
	let pdfFallbackUrl = $state<string | null>(null);

	let metaOpen = $state(false);

	function entryHasMediaMeta(): boolean {
		const k = kind;
		if (k === 'video') return true;
		return (
			k === 'image' &&
			(entry.name.toLowerCase().endsWith('.gif') || entry.contentType === 'image/gif')
		);
	}

	// PDF page state
	let pdfPageCount = $state(0);
	let pdfCurrentPage = $state(0);
	let pdfCanvas = $state<HTMLCanvasElement | null>(null);
	let imageSize = $state({ w: 1, h: 1 });

	/**
	 * What this document links to.
	 *
	 * Outward links are invisible until one breaks — which is how a copied
	 * project could point back at its original for weeks without anyone
	 * noticing. Saying so here costs nothing and is most of the fix.
	 */
	let links = $state<Array<{ name: string; missing: boolean }>>([]);

	$effect(() => {
		const id = entry.id;
		let cancelled = false;
		links = [];
		void driver
			.scanFileRefs?.(id)
			.then((found) => {
				if (!cancelled) links = found;
			})
			.catch(() => {
				// A scan that cannot run says nothing, rather than guessing.
			});
		return () => {
			cancelled = true;
		};
	});

	onDestroy(() => {
		revokeUrl();
	});

	function revokeUrl() {
		if (blobUrl?.startsWith('blob:')) URL.revokeObjectURL(blobUrl);
		blobUrl = null;
		if (pdfFallbackUrl?.startsWith('blob:')) URL.revokeObjectURL(pdfFallbackUrl);
		pdfFallbackUrl = null;
	}

	$effect(() => {
		const e = entry;
		const d = driver;
		const k = kind;
		if (k === 'text') {
			untrack(revokeUrl);
			loading = false;
			error = '';
			return;
		}
		if (!k || !canReadExplorerBlob(d)) {
			// untrack: revokeUrl() reads `blobUrl`. Reading it inside this effect
			// (even transitively) makes the effect depend on it — and the async
			// block below writes `blobUrl` once the fetch resolves, which would
			// then re-trigger this very effect, revoke the URL it just created,
			// and refetch forever. See the same note below.
			untrack(revokeUrl);
			loading = false;
			error = 'Preview not available for this file type';
			return;
		}

		let cancelled = false;
		// untrack: see comment above — must not make this effect depend on
		// `blobUrl`, or assigning it after the fetch resolves would loop.
		untrack(revokeUrl);
		loading = true;
		error = '';
		pdfPageCount = 0;
		pdfCurrentPage = 0;
		pdfBlob = null;
		imageSize = { w: 1, h: 1 };

		(async () => {
			try {
				if (k === 'image' && d.thumbUrl) {
					try {
						const loc = await d.thumbUrl(e.id, { maxDim: 1024 });
						if (cancelled) return;
						if (loc?.url) {
							const src = await embedMediaUrl(loc.url);
							if (cancelled) {
								if (src.startsWith('blob:')) URL.revokeObjectURL(src);
								return;
							}
							blobUrl = src;
							loading = false;
							return;
						}
					} catch {
						/* fall through to bytes */
					}
				}
				if (k === 'image' || k === 'video' || k === 'audio') {
					const src = await loadExplorerMediaSrc(d, e.id);
					if (cancelled) {
						if (src.url.startsWith('blob:')) URL.revokeObjectURL(src.url);
						return;
					}
					blobUrl = src.url;
					loading = false;
					return;
				}

				const blob = await readExplorerBlob(d, e.id);
				if (cancelled) return;
				if (!blob) {
					error = 'File is empty';
					loading = false;
					return;
				}
				const typed = coerceMediaBlob(blob, e.name, k);

				if (k === 'pdf') {
					pdfBlob = typed;
					// Canvas is behind `{#if loading}` — drop the spinner first so
					// bind:this can attach, then wait for that DOM flush.
					loading = false;
					await tick();
					if (cancelled) return;
					if (!pdfCanvas) {
						pdfFallbackUrl = URL.createObjectURL(typed);
						return;
					}
					try {
						pdfPageCount = await renderPdfPageToCanvas(pdfCanvas, typed, 0, 1000);
						pdfCurrentPage = 0;
					} catch {
						if (cancelled) return;
						pdfFallbackUrl = URL.createObjectURL(typed);
						error = '';
					}
				} else {
					blobUrl = URL.createObjectURL(typed);
					loading = false;
				}
			} catch (err) {
				if (!cancelled) {
					error = formatPreviewReadError(err);
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
			{#if mediaMeta && entryHasMediaMeta()}
				<button
					type="button"
					class="fe-float-meta-toggle"
					aria-pressed={metaOpen}
					data-testid="fe-float-meta-toggle"
					onclick={() => (metaOpen = !metaOpen)}
				>
					{metaOpen ? 'Hide metadata' : 'Show metadata'}
				</button>
			{/if}
			<button type="button" class="fe-float-close" data-testid="fe-float-close" aria-label="Close" onclick={onClose}>
				<FeIcon name="x" size={20} />
			</button>
		</div>
		{#if links.length}
			<p class="fe-float-links" data-testid="fe-float-links">
				Links to
				{#each links as link, i (link.name)}<span
						class:missing={link.missing}
						title={link.missing ? 'This file is no longer here' : undefined}
						>{link.name}{link.missing ? ' (missing)' : ''}</span
					>{i < links.length - 1 ? ', ' : ''}{/each}
			</p>
		{/if}
			{#if metaOpen && mediaMeta}
				<div class="fe-float-media-meta" data-testid="fe-float-meta">
					{@render mediaMeta({ entry, load: () => readExplorerBlob(driver, entry.id) })}
				</div>
			{/if}
			<div class="fe-float-body" class:text={kind === 'text'} class:image={kind === 'image'}>
			{#if loading}
				<div class="fe-float-loading">
					<div class="fe-float-spinner"></div>
				</div>
			{:else if error}
				<div class="fe-float-error">{error}</div>
			{:else if kind === 'image' && blobUrl}
				<PanZoomViewport
					contentWidth={imageSize.w}
					contentHeight={imageSize.h}
					testidPrefix="fe-float"
				>
					<img
						class="fe-float-image"
						src={blobUrl}
						alt={entry.name}
						onload={(e) => {
							const img = e.currentTarget as HTMLImageElement;
							imageSize = {
								w: img.naturalWidth || 1,
								h: img.naturalHeight || 1
							};
						}}
						onerror={() => (error = 'Image failed to display')}
					/>
				</PanZoomViewport>
			{:else if kind === 'video' && blobUrl}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video class="fe-float-video" src={blobUrl} controls autoplay playsinline></video>
			{:else if kind === 'audio' && blobUrl}
				<div class="fe-float-audio" data-testid="fe-float-audio">
					<FeIcon name="music" size={48} />
					<audio class="fe-float-audio-player" src={blobUrl} controls autoplay></audio>
				</div>
			{:else if kind === 'pdf' && pdfFallbackUrl}
				<iframe class="fe-float-pdf-frame" title={entry.name} src={pdfFallbackUrl}></iframe>
			{:else if kind === 'text'}
				<FeTextPreview {entry} {driver} maxChars={200_000} variant="full" />
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
	.fe-float-meta-toggle {
			flex-shrink: 0;
			background: none;
			border: 1px solid var(--line-hairline, #333);
			border-radius: 4px;
			color: var(--text-secondary, #aaa);
			cursor: pointer;
			padding: 3px 8px;
			font-size: 0.75rem;
		}
		.fe-float-meta-toggle:hover,
		.fe-float-meta-toggle[aria-pressed='true'] {
			background: var(--surface-3, #2a2a2a);
			color: var(--text-primary, #fff);
		}
		.fe-float-media-meta {
			padding: 0 12px 8px;
			display: flex;
			justify-content: center;
		}
		.fe-float-body {
		flex: 1;
		min-height: 0;
		overflow: auto;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.fe-float-body.text,
	.fe-float-body.image {
		align-items: stretch;
		justify-content: stretch;
	}
	.fe-float-body.image {
		overflow: hidden;
	}
	.fe-float-body :global(.pz-root) {
		width: 100%;
		height: 100%;
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
		width: 100%;
		height: 100%;
		object-fit: fill;
		display: block;
	}
	.fe-float-video {
		max-width: 100%;
		max-height: 100%;
		display: block;
	}
	.fe-float-audio {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1.25rem;
		width: min(28rem, calc(100% - 2rem));
		padding: 1.5rem 1rem;
		color: var(--text-muted, #888);
	}
	.fe-float-audio-player {
		width: 100%;
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
	.fe-float-pdf-frame {
		width: 100%;
		height: 100%;
		border: 0;
		background: #fff;
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
	.fe-float-links {
		margin: 0;
		padding: 0.25rem 0.75rem 0.5rem;
		font-size: 0.85em;
		opacity: 0.8;
	}
	.fe-float-links .missing {
		color: var(--color-danger, #c00);
		font-weight: 600;
	}
</style>
