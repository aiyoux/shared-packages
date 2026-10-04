<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import FeIcon from './FeIcon.svelte';
	import FeTypeMark from './FeTypeMark.svelte';
	import type { FeIconName } from './feIcons.js';
	import {
		getPreviewKind,
		generateThumbnail,
		previewKindIcon
	} from './feThumbnails.js';
	import type { ExplorerDriver, ExplorerEntry } from './explorerDriver.js';
	import {
		canReadExplorerBlob,
		embedMediaUrl,
		explorerThumbsAreEager,
		readExplorerBlob
	} from './explorerDriver.js';
	import { mediaSrcIsEmbeddable } from './saveToDisk.js';
	import { withLocalAddressSpace } from '../monitor/localNetwork.js';
	import {
		blobFromThumbSrc,
		recallThumb,
		rememberThumb,
		thumbCacheKey,
		thumbContentToken
	} from './thumbCache.js';

	let {
		entry,
		driver,
		maxDim = 96,
		enabled = true,
		/** Skip the click-to-load gate (preview pane after "Show me preview"). */
		force = false
	}: {
		entry: ExplorerEntry;
		driver: ExplorerDriver;
		maxDim?: number;
		enabled?: boolean;
		force?: boolean;
	} = $props();

	let url = $state<string | null>(null);
	let loading = $state(false);
	let failed = $state(false);
	let kind = $derived(getPreviewKind(entry));
	let eager = $derived(explorerThumbsAreEager(driver));
	/** User clicked the mini icon (B2 — no auto-download). */
	let requestedId = $state<string | null>(null);
	/** Last id we successfully rendered. Not set until the fetch finishes, so a
	 * cancelled in-flight load can restart instead of sticking on the spinner. */
	let loadedId = '';
	let loadedDriver: ExplorerDriver | null = null;
	let loadedDim = 0;
	let loadedName = '';
	let loadedToken: string | null = null;
	/** Where the current image came from. `cache` skips a rebuild on the next visit. */
	let source = $state<'cache' | 'fresh' | ''>('');
	const mediaId = $derived(entry.id);
	const mediaName = $derived(entry.name);
	const contentToken = $derived(thumbContentToken(entry));
	/** Last id that failed. Plain let so a fail does not re-run the effect. */
	let failedId = '';
	let failedToken: string | null = null;
	let shouldLoad = $derived(
		Boolean(
			enabled &&
				kind &&
				kind !== 'audio' &&
				kind !== 'text' &&
				(force || eager || requestedId === entry.id)
		)
	);

	onDestroy(() => {
		revoke();
	});

	async function fetchHostThumb(remote: string, key: string): Promise<string> {
		const res = await fetch(remote, withLocalAddressSpace(remote));
		if (!res.ok) throw new Error(`Could not load media (${res.status})`);
		const blob = await res.blob();
		void rememberThumb(key, blob);
		return URL.createObjectURL(blob);
	}

	function revoke() {
		if (url && url.startsWith('blob:')) {
			const retired = url;
			// Remove the old src before retiring it; lazy images may still be
			// queued for loading until Svelte flushes the DOM update.
			void tick().then(() => URL.revokeObjectURL(retired));
		}
		// data: URLs don't need revocation
		url = null;
		source = '';
	}

	$effect(() => {
		// Re-read entry/driver/enabled so effect re-runs on change
		const e = { id: mediaId, name: mediaName };
		const token = contentToken;
		const snap = untrack(() => entry);
		const dim = maxDim;
		const d = driver;
		const en = shouldLoad;
		// `kind` is a $derived read here, not written — writing it from inside
		// this effect and then reading it back in the same run used to make
		// the effect depend on its own write, forcing exactly one redundant
		// re-run right after mount. That re-run raced with (and cancelled) the
		// in-flight blob fetch below, and since `currentId` was already set by
		// the first run, the redundant run bailed out without restarting the
		// fetch — leaving the thumbnail stuck on "loading" forever.
		const k = kind;

		if (!en || !k || k === 'audio' || k === 'text' || !(canReadExplorerBlob(d) || typeof d.thumbUrl === 'function')) {
			// untrack: revoke() reads `url`. Reading it inside this effect (even
			// transitively) would make the effect depend on it — and the async
			// block below writes `url` once generation resolves, which would
			// then re-trigger this very effect, revoke the URL it just created,
			// and regenerate forever.
			untrack(revoke);
			loading = false;
			failed = false;
			return;
		}

		// untrack: reading `url` / `loading` here would subscribe the effect to
		// its own writes. A failed decode used to loop: fail → loading=false →
		// re-run → new blob URL → revoke → ERR_FILE_NOT_FOUND, and the row
		// stopped taking clicks.
		if (untrack(() => loadedId === e.id && loadedDriver === d && loadedDim === dim && loadedName === e.name && loadedToken === token && Boolean(url) && !loading)) return;
		if (untrack(() => failedId === e.id && failedToken === token)) return;

		let cancelled = false;
		untrack(revoke);
		loading = true;
		failed = false;
		loadedId = '';

		function show(src: string, from: 'cache' | 'fresh') {
			if (cancelled) {
				if (src.startsWith('blob:')) URL.revokeObjectURL(src);
				return false;
			}
			url = src;
			source = from;
			loadedId = e.id;
			loadedDriver = d;
			loadedDim = dim;
			loadedName = e.name;
			loadedToken = token;
			failedId = '';
			failedToken = null;
			loading = false;
			return true;
		}

		function fail() {
			if (cancelled) return;
			failedId = e.id;
			failedToken = token;
			failed = true;
			loading = false;
		}

		(async () => {
			try {
				const key = await thumbCacheKey(d, snap, dim);
				if (cancelled) return;
				if (key) {
					const cached = await recallThumb(key);
					if (cancelled) return;
					if (cached) {
						show(URL.createObjectURL(cached), 'cache');
						return;
					}
				}
				// Only image and video have host thumbs; pdf and others would
				// just get a benign 415 per row before the real path below.
				if ((k === 'image' || k === 'video') && d.thumbUrl) {
					try {
						const loc = await d.thumbUrl(e.id, { maxDim: dim });
						if (cancelled) return;
						if (loc?.url) {
							const src = key
								? await fetchHostThumb(loc.url, key)
								: await embedMediaUrl(loc.url);
							if (!src || !show(src, 'fresh')) return;
							return;
						}
					} catch {
						/* fall through */
					}
				}
				if (k === 'video' && d.thumbUrl && !force) {
					// Video row icons come from the host poster (monitor
					// `/v1/fs/thumb` extracts one frame with ffmpeg). No poster
					// support — cap off, ffmpeg missing, hostile clip — means
					// the film icon, never a whole-file download just to draw
					// a 96px icon. (`force` is the real preview pane, where the
					// user asked for the file.)
					fail();
					return;
				}
				if (k === 'image' && d.downloadUrl) {
					try {
						const loc = await d.downloadUrl(e.id);
						if (cancelled) return;
						if (loc?.url && mediaSrcIsEmbeddable(loc.url)) {
							show(loc.url, 'fresh');
							return;
						}
					} catch {
						/* fall through to bytes */
					}
				}
				const blob = await readExplorerBlob(d, e.id);
				if (cancelled) return;
				if (!blob) {
					fail();
					return;
				}
				const thumbUrl = await generateThumbnail(blob, k, dim, e.name);
				if (cancelled) {
					if (thumbUrl.startsWith('blob:')) URL.revokeObjectURL(thumbUrl);
					return;
				}
				if (key) {
					const preview = await blobFromThumbSrc(thumbUrl);
					if (preview) void rememberThumb(key, preview);
				}
				show(thumbUrl, 'fresh');
			} catch {
				fail();
			}
		})();

		return () => {
			cancelled = true;
		};
	});

	let fallbackIcon = $derived(
		kind ? previewKindIcon(kind) : ('file' as FeIconName)
	);
	/** Non-picture tiles: type glyph plus the extension, as one centered group. */
	let typeMark = $derived(!kind || (kind !== 'image' && kind !== 'video' && kind !== 'pdf'));
	const markIcon = $derived(Math.min(28, Math.max(14, Math.round(maxDim * 0.34))));
	const markLabel = $derived(Math.min(13, Math.max(8, Math.round(maxDim * 0.14))));

	function requestLoad(e: MouseEvent) {
		e.stopPropagation();
		e.preventDefault();
		requestedId = entry.id;
	}
</script>

<div class="fe-thumb" style:--fe-thumb-max="{maxDim}px" data-testid="fe-thumb">
	{#if url}
		<img class="fe-thumb-img" src={url} alt={entry.name} loading="lazy" data-thumb-source={source} />
		{#if kind === 'video'}
			<span class="fe-thumb-play" data-testid="fe-thumb-play" aria-hidden="true">
				<svg viewBox="0 0 24 24" aria-hidden="true">
					<polygon points="9 6 18.5 12 9 18" />
				</svg>
			</span>
		{/if}
	{:else if loading}
		<div class="fe-thumb-loading" aria-label="Loading preview">
			<div class="fe-thumb-spinner"></div>
		</div>
	{:else if failed}
		<div class="fe-thumb-fallback">
			<FeIcon name={fallbackIcon} size={Math.min(maxDim * 0.4, 32)} />
		</div>
	{:else if kind && kind !== 'text' && kind !== 'audio' && enabled && !shouldLoad}
		<button
			type="button"
			class="fe-thumb-load"
			data-testid="fe-thumb-load"
			aria-label="Load preview"
			title="Load preview"
			onclick={requestLoad}
		>
			<FeIcon name={fallbackIcon} size={Math.min(maxDim * 0.4, 32)} />
		</button>
	{:else if typeMark && entry.kind === 'file'}
		<div class="fe-thumb-fallback">
			<FeTypeMark {entry} iconSize={markIcon} labelSize={markLabel} />
		</div>
	{:else if kind}
		<div class="fe-thumb-fallback">
			<FeIcon name={fallbackIcon} size={Math.min(maxDim * 0.4, 32)} />
		</div>
	{:else}
		<div class="fe-thumb-fallback">
			<FeIcon name={entry.kind === 'folder' ? 'folder' : 'file'} size={Math.min(maxDim * 0.4, 32)} />
		</div>
	{/if}
</div>

<style>
	.fe-thumb {
		position: relative;
		width: 100%;
		height: 100%;
		max-width: var(--fe-thumb-max, 96px);
		max-height: var(--fe-thumb-max, 96px);
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	/* Sits on the poster so a video frame is not mistaken for a still. */
	.fe-thumb-play {
		position: absolute;
		left: 50%;
		top: 50%;
		translate: -50% -50%;
		width: clamp(10px, 40%, 28px);
		height: clamp(10px, 40%, 28px);
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		pointer-events: none;
		color: white;
		background: rgb(0 0 0 / 0.55);
		box-shadow: 0 0 0 1px rgb(255 255 255 / 0.4);
	}
	.fe-thumb-play svg {
		width: 54%;
		height: 54%;
		display: block;
		fill: currentColor;
	}
	.fe-thumb-img {
		width: 100%;
		height: 100%;
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
		display: block;
	}
	.fe-thumb-loading,
	.fe-thumb-fallback,
	.fe-thumb-load {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted, #888);
	}
	.fe-thumb-load {
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
		border-radius: 4px;
	}
	.fe-thumb-load:hover,
	.fe-thumb-load:focus-visible {
		color: var(--text-primary, #eee);
		outline: none;
		background: rgb(var(--overlay-rgb, 255 255 255) / 0.08);
	}
	.fe-thumb-spinner {
		width: 20px;
		height: 20px;
		border-radius: 50%;
		border: 2px solid currentColor;
		opacity: 0.25;
		border-top-color: var(--accent, #4a9);
		opacity: 1;
		animation: fe-thumb-spin 0.7s linear infinite;
	}
	@keyframes fe-thumb-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
