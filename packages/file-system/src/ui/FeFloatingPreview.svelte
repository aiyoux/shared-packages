<script lang="ts">
	import { onDestroy, tick, untrack, type Snippet } from 'svelte';
	import FeIcon from './FeIcon.svelte';
	import { portalModal } from './portal.js';
	import {
		coerceMediaBlob,
		getPreviewKind,
		renderPdfPageToCanvas
	} from './feThumbnails.js';
	import FeTextPreview from './FeTextPreview.svelte';
	import type { ExplorerDriver, ExplorerEntry } from './explorerDriver.js';
	import {
		canReadExplorerBlob,
		embedMediaUrl,
		loadExplorerMediaSrc,
		readExplorerBlob,
		type MediaMetaTarget
	} from './explorerDriver.js';
	import { formatPreviewReadError } from './explorerError.js';
	import { PanZoomViewport } from '@shared-packages/ui';

	let {
		entry,
		entries = [],
		driver,
		onClose,
		mediaMeta,
		variant = 'popup',
		loadMedia = true,
		onRequestMedia,
		infoLine = '',
		sizeText = '',
		projectState = null,
		actions,
		showClose = true
	}: {
		entry: ExplorerEntry;
		/** More than one entry replaces the media stage with the selection list. */
		entries?: ExplorerEntry[];
		driver: ExplorerDriver;
		onClose: () => void;
		/** Metadata panel for video / GIF previews — same slot as the docked preview. */
		mediaMeta?: Snippet<[MediaMetaTarget]>;
		variant?: 'popup' | 'dock';
		/** Popup loads immediately. A dock that follows selection waits. */
		loadMedia?: boolean;
		onRequestMedia?: () => void;
		/** Size, type, and updated time under the file name. */
		infoLine?: string;
		/** Combined size label for a multi-selection. */
		sizeText?: string;
		projectState?: boolean | null;
		actions?: Snippet;
		showClose?: boolean;
	} = $props();

	const multi = $derived(entries.length > 1);

	let blobUrl = $state<string | null>(null);
	let loading = $state(true);
	let error = $state('');
	let kind = $derived(getPreviewKind(entry));
	const mediaId = $derived(entry.id);
	const mediaName = $derived(entry.name);
	let loadedMedia: { id: string; name: string; kind: string; driver: ExplorerDriver } | null = null;
	/**
	 * The image viewer carries the actions in its own chrome, so the bottom bar
	 * steps aside, but only while that viewer is on screen. An image that fails
	 * to display (or is still loading) shows no viewer, and without the bar its
	 * preview would have no Open or Delete at all.
	 */
	const actionsInViewer = $derived(
		!multi && kind === 'image' && !!blobUrl && !!loadMedia && !loading && !error
	);
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
		if (entries.length > 1) {
			links = [];
			return;
		}
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
		const retired = [blobUrl, pdfFallbackUrl].filter((url): url is string => !!url?.startsWith('blob:'));
		void tick().then(() => {
			for (const url of retired) URL.revokeObjectURL(url);
		});
		blobUrl = null;
		pdfFallbackUrl = null;
	}

	$effect(() => {
		const e = { id: mediaId, name: mediaName };
		const d = driver;
		const k = kind;
		const shouldLoad = loadMedia && !multi;
		if (!shouldLoad) {
			untrack(revokeUrl);
			loading = false;
			error = '';
			return;
		}
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

		// List refreshes replace entry objects; keep the decoded media for the
		// same file and driver instead of retiring an image still on screen.
		if (untrack(() => loadedMedia?.id === e.id && loadedMedia.name === e.name &&
			loadedMedia.kind === k && loadedMedia.driver === d && !!blobUrl && !loading)) return;

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
							loadedMedia = { id: e.id, name: e.name, kind: k, driver: d };
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
					loadedMedia = { id: e.id, name: e.name, kind: k, driver: d };
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
		if (e.key === 'Escape') {
			onClose();
			return;
		}
		// Closing on Space unsets the parent's entry mid-dispatch, while this
		// window listener is still attached — the live prop reads null here.
		if (!entry) return;
		if (kind === 'pdf') {
			if (e.key === 'ArrowLeft') prevPage();
			if (e.key === 'ArrowRight') nextPage();
		}
	}

</script>

<svelte:window onkeydown={variant === 'popup' ? onKeydown : undefined} />

{#snippet stage()}
	<div
		class="fe-float-card"
		class:dock={variant === 'dock'}
		role={variant === 'popup' ? 'dialog' : 'region'}
		aria-modal={variant === 'popup' ? true : undefined}
		aria-label={multi ? `${entries.length} items selected` : entry.name}
		tabindex="-1"
		data-fe-is-project={projectState === true ? 'true' : projectState === false ? 'false' : undefined}
		onclick={(e) => e.stopPropagation()}
	>
		<div class="fe-float-header">
			<div class="fe-float-heading">
				<span class="fe-float-title" data-testid="fe-file-preview-name" title={multi ? `${entries.length} items selected` : entry.name}>
					{multi ? `${entries.length} items selected` : entry.name}
				</span>
				{#if multi}
					<p class="fe-float-sub">
						<span data-testid="fe-file-preview-count">{entries.length}</span>
						items ·
						<span data-testid="fe-file-preview-size">{sizeText}</span>
					</p>
				{:else if infoLine}
					<p class="fe-float-sub" data-testid="fe-file-preview-info">{infoLine}</p>
				{/if}
			</div>
			{#if !multi && mediaMeta && entryHasMediaMeta()}
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
			{#if showClose}
				<button type="button" class="fe-float-close" data-testid="fe-file-preview-close" aria-label="Close" onclick={onClose}>
					<FeIcon name="x" size={20} />
				</button>
			{/if}
		</div>
		{#if !multi && links.length}
			<p class="fe-float-links" data-testid="fe-float-links">
				Links to
				{#each links as link, i (link.name)}<span
						class:missing={link.missing}
						title={link.missing ? 'This file is no longer here' : undefined}
						>{link.name}{link.missing ? ' (missing)' : ''}</span
					>{i < links.length - 1 ? ', ' : ''}{/each}
			</p>
		{/if}
		{#if !multi && metaOpen && mediaMeta}
			<div class="fe-float-media-meta" data-testid="fe-float-meta">
				{@render mediaMeta({ entry, load: () => readExplorerBlob(driver, entry.id) })}
			</div>
		{/if}
		<div class="fe-float-body" class:text={!multi && kind === 'text'} class:image={!multi && kind === 'image' && !!blobUrl}>
			{#if multi}
				<ul class="fe-float-items" data-testid="fe-file-preview-items">
					{#each entries as n (n.id)}
						<li data-testid="fe-file-preview-item" data-name={n.name} data-kind={n.kind}>
							<FeIcon name={n.kind === 'folder' ? 'folder' : 'file'} size={14} />
							<span class="fe-float-item-name">{n.name}</span>
						</li>
					{/each}
				</ul>
			{:else if kind && !loadMedia}
				<button type="button" class="ds-btn ds-btn--sm ds-btn--secondary" data-testid="fe-show-preview" onclick={() => onRequestMedia?.()}>
					Show preview
				</button>
			{:else if loading}
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
					chromeLeading={actions}
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
				<video class="fe-float-video" src={blobUrl} controls playsinline preload="metadata"></video>
			{:else if kind === 'audio' && blobUrl}
				<div class="fe-float-audio" data-testid="fe-float-audio">
					<FeIcon name="music" size={48} />
					<audio class="fe-float-audio-player" src={blobUrl} controls preload="metadata"></audio>
				</div>
			{:else if kind === 'pdf' && pdfFallbackUrl}
				<iframe class="fe-float-pdf-frame" title={entry.name} src={pdfFallbackUrl}></iframe>
			{:else if kind === 'text'}
				<FeTextPreview {entry} {driver} maxChars={variant === 'dock' ? 4_000 : 200_000} variant={variant === 'dock' ? 'snippet' : 'full'} />
			{:else if kind === 'pdf'}
				<div class="fe-float-pdf">
					<canvas bind:this={pdfCanvas} class="fe-float-pdf-canvas"></canvas>
				</div>
			{:else}
				<div class="fe-float-fallback" data-testid="fe-float-fallback">
					<FeIcon name={entry.kind === 'folder' ? 'folder' : 'file'} size={48} />
				</div>
			{/if}
		</div>
		{#if actions && !actionsInViewer}
			<div class="fe-float-bar">
				<div class="fe-float-actions">{@render actions()}</div>
				{#if !multi && kind === 'pdf' && pdfPageCount > 1}
					<div class="fe-float-pdf-nav">
						<button type="button" class="ds-btn ds-btn--sm ds-btn--ghost" onclick={prevPage} disabled={pdfCurrentPage === 0} aria-label="Previous page">
							<FeIcon name="chevron-left" size={16} />
						</button>
						<span class="fe-float-pdf-pager">{pdfCurrentPage + 1} / {pdfPageCount}</span>
						<button type="button" class="ds-btn ds-btn--sm ds-btn--ghost" onclick={nextPage} disabled={pdfCurrentPage >= pdfPageCount - 1} aria-label="Next page">
							<FeIcon name="chevron-right" size={16} />
						</button>
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#if variant === 'popup'}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="portal-root" use:portalModal>
		<div
			class="fe-float-backdrop"
			data-testid="fe-file-preview"
			data-multi={multi ? 'true' : undefined}
			onclick={onClose}
		>
			{@render stage()}
		</div>
	</div>
{:else}
	{@render stage()}
{/if}

<style>
	.portal-root {
		display: contents;
	}
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
	.fe-float-card.dock {
		width: 100%;
		height: 100%;
		min-height: 0;
		border: none;
		border-radius: 0;
		box-shadow: none;
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
	.fe-float-heading {
		flex: 1;
		min-width: 0;
	}
	.fe-float-title {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
		font-size: 0.9rem;
	}
	.fe-float-sub {
		margin: 2px 0 0;
		font-size: 0.75rem;
		color: var(--text-muted, #aaa);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.fe-float-bar {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 4px 8px;
		border-top: 1px solid var(--line-hairline, #333);
		background: var(--surface-2, #1c1c24);
	}
	.fe-float-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 2px;
		min-width: 0;
	}
	.fe-float-items {
		list-style: none;
		margin: 0;
		padding: 12px;
		width: 100%;
		overflow: auto;
		display: grid;
		gap: 4px;
		align-content: start;
	}
	.fe-float-items li {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font-size: 0.85rem;
	}
	.fe-float-item-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.fe-float-fallback {
		color: var(--text-muted, #888);
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
