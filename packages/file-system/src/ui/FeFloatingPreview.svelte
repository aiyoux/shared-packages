<script lang="ts">
	import { overlay } from '@shared-packages/design-system';
	import { onDestroy, tick, untrack, type Snippet } from 'svelte';
	import FeIcon from './FeIcon.svelte';
	import FeThumbnail from './FeThumbnail.svelte';
	import { portalModal } from './portal.js';
	import {
		coerceMediaBlob,
		getPreviewKind,
		openPreviewPdf,
		type PreviewPdf
	} from './feThumbnails.js';
	import { convertedMediaSrc, needsConversion, streamableMediaSrc } from './mediaStream.js';
	import { RANGED, type MediaTimeline } from './mediaClock.js';
	import FeVideoPlayer from './FeVideoPlayer.svelte';
	import FeAudioPlayer from './FeAudioPlayer.svelte';
	import { peaksFromBlob } from '@shared-packages/ui/waveform';
	import { fetchByteRange } from './rangedRead.js';
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
	import { formatFolderMeasure, measureFolderSize, type FolderMeasure } from './folderSize.js';
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
		showClose = true,
		/**
		 * Folder listing parent. Omit to list `entry.id`. `null` is the driver
		 * root, which has no folder id of its own.
		 */
		listParentId = undefined as string | null | undefined
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
		listParentId?: string | null;
	} = $props();

	const multi = $derived(entries.length > 1);

	let blobUrl = $state<string | null>(null);
	let loading = $state(true);
	let error = $state('');
	// A video the browser cannot decode still previews when the host converts it.
	let kind = $derived(
		getPreviewKind(entry) ??
			(needsConversion(entry.name) && typeof driver.convertedMediaUrl === 'function' ? 'video' : null)
	);
	const entryKind = $derived(entry.kind);
	const mediaId = $derived(entry.id);
	const mediaName = $derived(entry.name);
	const mediaSize = $derived(entry.size);
	const RANGED_PDF_ABOVE_BYTES = 8 * 1024 * 1024;

	/** Longest edge of the stage in device pixels, for a host-rendered image. */
	function stagePixels(): number {
		if (typeof window === 'undefined') return 1024;
		// The docked pane is a side panel, never the whole window.
		if (variant === 'dock') return 1024;
		const css = Math.max(window.innerWidth, window.innerHeight);
		return Math.min(4096, Math.max(256, Math.round(css * (window.devicePixelRatio || 1))));
	}
	/** Parent passed to `driver.list` for a folder preview. */
	const folderListParent = $derived(listParentId === undefined ? mediaId : listParentId);
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
	let pdfDoc = $state<PreviewPdf | null>(null);
	/** Set while the player streams by ranges; a failed stream falls back to bytes. */
	let streamedFrom: { id: string; name: string; driver: ExplorerDriver; converted: boolean } | null = null;
	/**
	 * A converted stream has no ranges: it plays from where it was started
	 * (`start`), and a seek past what it holds restarts it there. The players
	 * show the file's time either way (`mediaClock.ts`).
	 */
	let converted = $state<{ duration?: number; start: number } | null>(null);
	const mediaTimeline = $derived<MediaTimeline>(
		converted ? { start: converted.start, duration: converted.duration, restartable: true } : RANGED
	);

	/** Restart the converted stream at file second `seconds`; the player stays. */
	async function restartAt(seconds: number) {
		const from = streamedFrom;
		if (!from?.converted || from.id !== entry?.id) return;
		const next = await convertedMediaSrc(from.driver, from.id, from.name, seconds).catch(() => null);
		if (!next || entry?.id !== from.id) return;
		// The host may start a copied video on the keyframe before `seconds`.
		converted = { duration: next.duration ?? converted?.duration, start: next.start ?? seconds };
		blobUrl = next.src;
	}

	/** Waveform bars for the audio player. */
	let audioPeaks = $state<number[] | null>(null);
	let peaksLoading = $state(false);
	/** Below this a remote file is decoded here for its waveform; above it only the host's peaks are used. */
	const BROWSER_PEAKS_MAX_BYTES = 32 * 1024 * 1024;

	async function peaksFor(d: ExplorerDriver, id: string, size: number | undefined, blob?: Blob): Promise<number[] | null> {
		if (blob) return (await peaksFromBlob(blob, 50)).samples;
		const host = await d.audioPeaks?.(id, { n: 1200 }).catch(() => null);
		if (host?.peaks.length) return host.peaks;
		if (size !== undefined && size <= BROWSER_PEAKS_MAX_BYTES && canReadExplorerBlob(d)) {
			return (await peaksFromBlob(await readExplorerBlob(d, id), 50)).samples;
		}
		return null;
	}

	function startPeaks(d: ExplorerDriver, id: string, size: number | undefined, blob?: Blob) {
		peaksLoading = true;
		void peaksFor(d, id, size, blob)
			.catch(() => null)
			.then((p) => {
				if (entry?.id !== id) return;
				audioPeaks = p;
				peaksLoading = false;
			});
	}

	/** The stream would not play: try the host's converted stream, then bytes. */
	async function streamFailed() {
		const from = streamedFrom;
		streamedFrom = null;
		if (!from) {
			error = 'This browser cannot play this audio or video format. Download it or open it in a compatible app.';
			return;
		}
		if (from.id !== entry?.id) return;
		loading = true;
		try {
			if (!from.converted) {
				const next = await convertedMediaSrc(from.driver, from.id, from.name);
				if (next && entry?.id === from.id) {
					streamedFrom = { ...from, converted: true };
					converted = { duration: next.duration, start: 0 };
					blobUrl = next.src;
					return;
				}
			}
			const src = await loadExplorerMediaSrc(from.driver, from.id);
			if (entry?.id !== from.id) {
				if (src.url.startsWith('blob:')) URL.revokeObjectURL(src.url);
				return;
			}
			blobUrl = src.url;
		} catch (err) {
			error = formatPreviewReadError(err);
		} finally {
			loading = false;
		}
	}
	let pdfFallbackUrl = $state<string | null>(null);

	let metaOpen = $state(false);
	let metaTrigger = $state<HTMLButtonElement | null>(null);
	let bodyEl = $state<HTMLDivElement | null>(null);
	/** Popover origin, in pixels, over the image or video box. */
	let metaAnchor = $state<{ top: number; left: number; maxWidth: number; maxHeight: number } | null>(null);
	let folderMeasure = $state<FolderMeasure | null>(null);
	let folderMeasureBusy = $state(false);
	let folderMeasureError = $state('');
	let measureAbort: AbortController | null = null;

	function entryHasMediaMeta(): boolean {
		return kind === 'video' || kind === 'image';
	}

	// Keep the metadata card on the picture. The stage is often taller than the
	// fitted image or video, so a card pinned to the stage sits in the gap above it.
	$effect(() => {
		const stage = bodyEl;
		const open = metaOpen && !multi && mediaMeta != null && entryHasMediaMeta();
		const entryId = entry?.id;
		if (!stage || !open || !entryId) {
			metaAnchor = null;
			return;
		}
		let mediaRo: ResizeObserver | null = null;
		let watching: Element | null = null;
		const place = () => {
			const media = stage.querySelector('video.fe-float-video, img.fe-float-image');
			if (media !== watching) {
				mediaRo?.disconnect();
				mediaRo = null;
				watching = media;
				if (media && typeof ResizeObserver !== 'undefined') {
					mediaRo = new ResizeObserver(() => place());
					mediaRo.observe(media);
				}
			}
			if (!media) {
				if (untrack(() => metaAnchor) !== null) metaAnchor = null;
				return;
			}
			const sr = stage.getBoundingClientRect();
			const mr = media.getBoundingClientRect();
			if (mr.width < 2 || mr.height < 2 || sr.width < 2) return;
			const controlRoom = media.tagName === 'VIDEO' ? 48 : 0;
			const top = Math.round(Math.max(8, mr.top - sr.top + 8));
			const left = Math.round(Math.max(8, mr.left - sr.left + 8));
			const maxWidth = Math.round(Math.max(96, Math.min(mr.width - 16, sr.width - left - 8)));
			const spare = mr.height - 16 - controlRoom;
			const maxHeight = Math.round(
				Math.max(48, Math.min(spare >= 48 ? spare : mr.height - 16, sr.height - top - 8))
			);
			const prev = untrack(() => metaAnchor);
			if (
				prev &&
				prev.top === top &&
				prev.left === left &&
				prev.maxWidth === maxWidth &&
				prev.maxHeight === maxHeight
			) {
				return;
			}
			metaAnchor = { top, left, maxWidth, maxHeight };
		};
		place();
		const stageRo = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => place()) : null;
		stageRo?.observe(stage);
		const mo = new MutationObserver(() => place());
		mo.observe(stage, { subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
		return () => {
			stageRo?.disconnect();
			mediaRo?.disconnect();
			mo.disconnect();
		};
	});

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

	/** Children of the selected folder. A mismatched id means the list is still for the previous folder. */
	let folderList = $state<{
		id: string;
		status: 'ready' | 'error';
		entries: ExplorerEntry[];
		truncated: boolean;
		error: string;
	} | null>(null);

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

	$effect(() => {
		const id = entryKind === 'folder' ? mediaId : '';
		folderMeasure = null;
		folderMeasureBusy = false;
		folderMeasureError = '';
		const ac = new AbortController();
		measureAbort = ac;
		void id;
		return () => {
			ac.abort();
			if (measureAbort === ac) measureAbort = null;
		};
	});

	function folderInfoRest(line: string): string {
		return line.replace(/^Unknown size(?: · )?/, '').trim();
	}

	function listedKindCount(kindName: 'file' | 'folder'): number {
		if (!folderList || folderList.id !== entry.id || folderList.status !== 'ready') return 0;
		return folderList.entries.reduce((n, child) => n + (child.kind === kindName ? 1 : 0), 0);
	}

	async function calculateFolderSize() {
		if (entryKind !== 'folder' || folderMeasureBusy) return;
		const id = mediaId;
		const parent = folderListParent;
		const signal = measureAbort?.signal;
		if (!signal || signal.aborted) return;
		folderMeasureBusy = true;
		folderMeasureError = '';
		try {
			const result = await measureFolderSize(driver, parent, { signal });
			if (signal.aborted || mediaId !== id) return;
			folderMeasure = result;
		} catch (err) {
			if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
			folderMeasureError = 'Could not calculate size';
		} finally {
			if (!signal.aborted && mediaId === id) folderMeasureBusy = false;
		}
	}

	$effect(() => {
		if (multi || entryKind !== 'folder') return;
		const id = mediaId;
		const parent = folderListParent;
		const d = driver;
		let cancelled = false;
		void d
			.list({ parentId: parent })
			.then((result) => {
				if (cancelled) return;
				folderList = {
					id,
					status: 'ready',
					entries: result.entries,
					truncated: result.truncated,
					error: ''
				};
			})
			.catch((err) => {
				if (cancelled) return;
				folderList = {
					id,
					status: 'error',
					entries: [],
					truncated: false,
					error: formatPreviewReadError(err)
				};
			});
		return () => {
			cancelled = true;
		};
	});

	onDestroy(() => {
		revokeUrl();
		pdfDoc?.close();
		pdfDoc = null;
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
		const entrySize = mediaSize;
		const d = driver;
		const k = kind;
		const shouldLoad = loadMedia && !multi;
		if (!shouldLoad) {
			untrack(revokeUrl);
			loading = false;
			error = '';
			return;
		}
		if (entryKind === 'folder') {
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
		streamedFrom = null;
		converted = null;
		audioPeaks = null;
		peaksLoading = false;
		loading = true;
		error = '';
		pdfPageCount = 0;
		pdfCurrentPage = 0;
		untrack(() => pdfDoc?.close());
		pdfDoc = null;
		imageSize = { w: 1, h: 1 };

		(async () => {
			try {
				if (k === 'image' && d.thumbUrl) {
					try {
						// The host renders it at the size it is shown, so a large
						// photo is viewed without its original leaving the host.
						const loc = await d.thumbUrl(e.id, { maxDim: stagePixels() });
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
				if (k === 'video' || k === 'audio') {
					// Played by ranges: only the part around the playhead moves. A
					// container the browser cannot play goes to the converter first.
					const conv = needsConversion(e.name) ? await convertedMediaSrc(d, e.id, e.name) : null;
					const streamed = conv?.src ?? (await streamableMediaSrc(d, e.id, e.name));
					if (cancelled) return;
					if (streamed) {
						blobUrl = streamed;
						streamedFrom = { id: e.id, name: e.name, driver: d, converted: conv !== null };
						converted = conv ? { duration: conv.duration, start: 0 } : null;
						if (k === 'audio') startPeaks(d, e.id, entrySize);
						loadedMedia = { id: e.id, name: e.name, kind: k, driver: d };
						loading = false;
						return;
					}
				}
				// A big PDF opens by ranges: pdf.js reads about one chunk per page
				// plus what page 1 draws. A small one is cheaper read whole.
				if (k === 'pdf' && d.rangeUrl && entrySize !== undefined && entrySize > RANGED_PDF_ABOVE_BYTES) {
					const loc = await d.rangeUrl(e.id).catch(() => null);
					if (cancelled) return;
					if (loc?.url) {
						const url = loc.url;
						const doc = await openPreviewPdf({
							url,
							size: entrySize,
							read: async (begin, end) => (await fetchByteRange(url, begin, end - 1)).bytes
						});
						if (cancelled) {
							doc.close();
							return;
						}
						pdfDoc = doc;
						loading = false;
						await tick();
						if (cancelled || !pdfCanvas) return;
						await doc.render(pdfCanvas, 0, 1000);
						pdfPageCount = doc.pageCount;
						pdfCurrentPage = 0;
						return;
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
					if (k === 'audio') startPeaks(d, e.id, entrySize, src.blob);
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
						const doc = await openPreviewPdf({ blob: typed });
						if (cancelled) {
							doc.close();
							return;
						}
						pdfDoc = doc;
						await doc.render(pdfCanvas, 0, 1000);
						pdfPageCount = doc.pageCount;
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
		if (!pdfDoc || !pdfCanvas) return;
		try {
			await pdfDoc.render(pdfCanvas, pageIdx, 1000);
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
				{:else if entryKind === 'folder'}
					<div class="fe-float-sub" data-testid="fe-file-preview-info">
						{#if folderMeasure}
							<span data-testid="fe-folder-size">{formatFolderMeasure(folderMeasure)}</span>
						{:else}
							<button
								type="button"
								class="fe-folder-calc"
								data-testid="fe-folder-calc-size"
								disabled={folderMeasureBusy}
								onclick={() => void calculateFolderSize()}
							>
								{folderMeasureBusy ? 'Calculating…' : 'Calculate size'}
							</button>
						{/if}
						{#if folderMeasureError}
							<span class="fe-folder-size-error" data-testid="fe-folder-size-error">{folderMeasureError}</span>
						{/if}
						{#if folderInfoRest(infoLine)}
							<span> · {folderInfoRest(infoLine)}</span>
						{/if}
					</div>
				{:else if infoLine}
					<p class="fe-float-sub" data-testid="fe-file-preview-info">{infoLine}</p>
				{/if}
			</div>
			{#if !multi && (entryKind === 'folder' || (mediaMeta && entryHasMediaMeta()))}
				<button
					type="button"
					class="fe-float-meta-toggle" bind:this={metaTrigger}
					aria-pressed={metaOpen}
					aria-expanded={metaOpen}
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
		{#if !multi && metaOpen && entryKind === 'folder'}
			<div class="fe-float-media-meta" data-testid="fe-folder-meta">
				<dl class="fe-folder-meta">
					<div class="fe-folder-meta-row">
						<dt>Items</dt>
						<dd data-testid="fe-folder-meta-items">
							{#if !folderList || folderList.id !== entry.id}
								…
							{:else if folderList.status === 'error'}
								—
							{:else}
								{folderList.entries.length}{folderList.truncated ? ' (more not shown)' : ''}
							{/if}
						</dd>
					</div>
					<div class="fe-folder-meta-row">
						<dt>Folders</dt>
						<dd data-testid="fe-folder-meta-folders">{folderMeasure ? folderMeasure.folders : listedKindCount('folder')}</dd>
					</div>
					<div class="fe-folder-meta-row">
						<dt>Files</dt>
						<dd data-testid="fe-folder-meta-files">{folderMeasure ? folderMeasure.files : listedKindCount('file')}</dd>
					</div>
					<div class="fe-folder-meta-row">
						<dt>Size</dt>
						<dd data-testid="fe-folder-meta-size">{folderMeasure ? formatFolderMeasure(folderMeasure) : 'Not calculated'}</dd>
					</div>
					{#if entry.updatedAt}
						<div class="fe-folder-meta-row">
							<dt>Modified</dt>
							<dd data-testid="fe-folder-meta-modified">{new Date(entry.updatedAt).toLocaleString()}</dd>
						</div>
					{/if}
				</dl>
			</div>
		{/if}
		<div
			class="fe-float-body"
			bind:this={bodyEl}
			class:text={!multi && kind === 'text'}
			class:image={!multi && kind === 'image' && !!blobUrl}
			class:video={!multi && kind === 'video' && !!blobUrl}
			class:folder={!multi && entryKind === 'folder'}
		>
			{#if multi}
				<ul class="fe-float-items" data-testid="fe-file-preview-items">
					{#each entries as n (n.id)}
						<li data-testid="fe-file-preview-item" data-name={n.name} data-kind={n.kind}>
							<FeIcon name={n.kind === 'folder' ? 'folder' : 'file'} size={14} />
							<span class="fe-float-item-name">{n.name}</span>
						</li>
					{/each}
				</ul>
			{:else if entryKind === 'folder'}
				{#if !folderList || folderList.id !== entry.id}
					<div class="fe-float-loading">
						<div class="fe-float-spinner"></div>
					</div>
				{:else if folderList.status === 'error'}
					<div class="fe-float-error">{folderList.error}</div>
				{:else if folderList.entries.length === 0}
					<div class="fe-folder-empty" data-testid="fe-folder-preview-empty">Folder is empty</div>
				{:else}
					<ul class="fe-folder-preview" data-testid="fe-folder-preview">
						{#each folderList.entries as child (child.id)}
							<li data-testid="fe-folder-preview-item" data-name={child.name} data-kind={child.kind}>
								<span class="fe-folder-preview-thumb">
									<FeThumbnail entry={child} {driver} maxDim={64} />
								</span>
								<span class="fe-folder-preview-name">{child.name}</span>
							</li>
						{/each}
						{#if folderList.truncated}
							<li class="fe-folder-preview-more" data-testid="fe-folder-preview-truncated">More items are not shown</li>
						{/if}
					</ul>
				{/if}
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
				<FeVideoPlayer
					src={blobUrl}
					name={entry.name}
					timeline={mediaTimeline}
					onRestart={(at) => void restartAt(at)}
					onError={() => void streamFailed()}
					testid="fe-float-video"
				/>
			{:else if kind === 'audio' && blobUrl}
				<div class="fe-float-audio" data-testid="fe-float-audio">
					<FeAudioPlayer
						src={blobUrl}
						name={entry.name}
						peaks={audioPeaks}
						{peaksLoading}
						timeline={mediaTimeline}
						onRestart={(at) => void restartAt(at)}
						onError={() => void streamFailed()}
					/>
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
			{#if !multi && metaOpen && mediaMeta && entryHasMediaMeta()}
				<div
					class="fe-float-meta-popover" use:overlay={{ kind: 'popover', anchor: () => metaTrigger, onClose: () => (metaOpen = false) }}
					data-testid="fe-float-meta"
					role="region"
					aria-label="Metadata"
					style:top={metaAnchor ? `${metaAnchor.top}px` : null}
					style:left={metaAnchor ? `${metaAnchor.left}px` : null}
					style:max-width={metaAnchor ? `${metaAnchor.maxWidth}px` : null}
					style:max-height={metaAnchor ? `${metaAnchor.maxHeight}px` : null}
					style:visibility={metaAnchor ? null : 'hidden'}
				>
					<button
						type="button"
						class="fe-float-meta-close"
						data-testid="fe-float-meta-close"
						aria-label="Close metadata"
						onclick={() => (metaOpen = false)}
					>
						<FeIcon name="x" size={14} />
					</button>
					<div class="fe-float-meta-body">
						{@render mediaMeta({ entry, load: () => readExplorerBlob(driver, entry.id) })}
					</div>
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
			use:overlay={{ kind: 'modal', panel: '.fe-float-card', onClose }}
			data-testid="fe-file-preview"
			data-multi={multi ? 'true' : undefined}
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
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: auto;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.fe-float-meta-popover {
		position: absolute;
		z-index: 4;
		top: 8px;
		left: 8px;
		display: flex;
		flex-direction: column;
		width: min(22rem, calc(100% - 16px));
		max-height: calc(100% - 16px);
		overflow: hidden;
		background: var(--surface-2);
		border: 1px solid var(--line-hairline);
		border-radius: 6px;
	}
	.fe-float-meta-close {
		align-self: flex-end;
		flex-shrink: 0;
		margin: 2px 2px 0 0;
		background: none;
		border: none;
		color: var(--text-secondary, #aaa);
		cursor: pointer;
		padding: 2px;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.fe-float-meta-close:hover {
		background: var(--surface-3, #2a2a2a);
		color: var(--text-primary, #fff);
	}
	.fe-float-meta-body {
		min-height: 0;
		overflow: auto;
	}
	.fe-float-body.text,
	.fe-float-body.image,
	.fe-float-body.folder {
		align-items: stretch;
		justify-content: stretch;
	}
	.fe-folder-preview {
		list-style: none;
		margin: 0;
		padding: 8px;
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 2px;
		align-content: start;
	}
	.fe-folder-preview li {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		padding: 4px 6px;
	}
	.fe-folder-preview-thumb {
		flex: 0 0 40px;
		width: 40px;
		height: 40px;
	}
	.fe-folder-preview-thumb :global(.fe-thumb) {
		width: 40px;
		height: 40px;
	}
	.fe-folder-preview-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.85rem;
	}
	.fe-folder-preview-more {
		color: var(--text-muted);
		font-size: 0.75rem;
	}
	.fe-folder-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		color: var(--text-muted);
		text-align: center;
		padding: 24px;
	}
	.fe-folder-calc {
		margin: 0;
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		font: inherit;
		font-size: inherit;
		cursor: pointer;
		text-decoration: underline;
	}
	.fe-folder-calc:disabled {
		color: var(--text-muted);
		cursor: default;
		text-decoration: none;
	}
	.fe-folder-size-error {
		color: var(--cat-red-soft);
	}
	.fe-folder-meta {
		margin: 0;
		display: grid;
		gap: 4px 16px;
		padding: 10px 12px;
		border: 1px solid var(--line-hairline);
		border-radius: 6px;
		background: var(--surface-3);
		font-size: 0.78rem;
		text-align: left;
	}
	.fe-folder-meta-row {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 16px;
	}
	.fe-folder-meta dt {
		color: var(--text-secondary);
		font-weight: 600;
	}
	.fe-folder-meta dd {
		margin: 0;
		color: var(--text-primary);
	}
	.fe-float-body.image,
	.fe-float-body.video {
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
	.fe-float-audio {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1.25rem;
		width: min(44rem, calc(100% - 2rem));
		padding: 1.5rem 1rem;
		color: var(--text-muted, #888);
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
