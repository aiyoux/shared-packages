<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import FeIcon from './FeIcon.svelte';
	import FeTypeMark from './FeTypeMark.svelte';
	import type { FeIconName } from './feIcons.js';
	import { getPreviewKind, generateThumbnail, previewKindIcon } from './feThumbnails.js';
	import type { ExplorerDriver, ExplorerEntry } from './explorerDriver.js';
	import { canReadExplorerBlob, explorerThumbsAreEager, isRemoteClass, readExplorerBlob } from './explorerDriver.js';
	import { withLocalAddressSpace } from '../monitor/localNetwork.js';
	import { blobFromThumbSrc, recallThumbResult, rememberThumb, rememberThumbFailure, thumbCacheKey, thumbContentToken, versionedThumbUrl } from './thumbCache.js';
	import { observePreviewVisibility, sharedPreviewWork } from './previewWork.js';

	let { entry, driver, maxDim = 96, enabled = true, force = false }: {
		entry: ExplorerEntry; driver: ExplorerDriver; maxDim?: number; enabled?: boolean; force?: boolean;
	} = $props();
	let url = $state<string | null>(null);
	let loading = $state(false);
	let failed = $state(false);
	let nearViewport = $state(false);
	let kind = $derived(getPreviewKind(entry));
	let eager = $derived(explorerThumbsAreEager(driver) && !(kind === 'pdf' && isRemoteClass(driver.id)));
	let requestedId = $state<string | null>(null);
	let requestVersion = $state(0);
	let source = $state<'cache' | 'fresh' | ''>('');
	const mediaId = $derived(entry.id);
	const mediaName = $derived(entry.name);
	const contentToken = $derived(thumbContentToken(entry));
	const shouldLoad = $derived(enabled && (force || eager || requestedId === mediaId));
	let loaded: { id: string; name: string; driver: ExplorerDriver; dim: number; token: string | null } | null = null;
	let observed: { id: string; driver: ExplorerDriver; token: string | null } | null = null;
	let failedLoad: { id: string; driver: ExplorerDriver; dim: number; token: string | null; request: number; until: number } | null = null;

	onDestroy(revoke);
	function revoke() {
		if (url?.startsWith('blob:')) {
			const retired = url;
			void tick().then(() => URL.revokeObjectURL(retired));
		}
		url = null; source = ''; loaded = null;
	}

	$effect(() => {
		const e = { id: mediaId, name: mediaName };
		const token = contentToken;
		const snap = untrack(() => entry);
		const dim = maxDim;
		const d = driver;
		const k = kind;
		const en = enabled;
		const explicit = force || requestedId === e.id;
		const allowOriginal = force || (explicit && k !== 'video');
		const visible = nearViewport || explicit;
		const generate = shouldLoad;
		const request = requestVersion;
		if (!en || !visible || !k || k === 'audio' || k === 'text' || k === 'kb' || !(canReadExplorerBlob(d) || d.thumbUrl)) {
			untrack(revoke); loading = false; failed = false; return;
		}
		if (untrack(() => loaded?.id === e.id && loaded.driver === d && loaded.dim === dim && loaded.name === e.name && loaded.token === token && Boolean(url))) return;
		if (failedLoad?.id === e.id && failedLoad.driver === d && failedLoad.dim === dim && failedLoad.token === token && failedLoad.request === request && failedLoad.until > Date.now()) {
			failed = true; loading = false; return;
		}
		const changing = observed?.id === e.id && observed.driver === d && observed.token !== token;
		observed = { id: e.id, driver: d, token };
		const controller = new AbortController();
		const signal = controller.signal;
		loading = true; failed = false;
		// Keep the old poster until the new stable version arrives.
		if (untrack(() => loaded?.id !== e.id || loaded.driver !== d)) untrack(revoke);
		const timer = setTimeout(() => { void load(); }, changing && !explicit ? 750 : 0);

		function show(blob: Blob, from: 'cache' | 'fresh') {
			if (signal.aborted) return;
			revoke();
			url = URL.createObjectURL(blob); source = from;
			loaded = { ...e, driver: d, dim, token }; loading = false; failed = false;
			failedLoad = null;
		}
		async function load() {
			let key: string | null = null;
			try {
				key = await thumbCacheKey(d, snap, dim);
				if (signal.aborted) return;
				const cached = key ? await recallThumbResult(key) : null;
				if (signal.aborted) return;
				if (cached instanceof Blob) { show(cached, 'cache'); return; }
				if (cached === 'failed' && !explicit) { revoke(); failed = true; loading = false; return; }
				if (!generate) { revoke(); loading = false; return; }
				const blob = await sharedPreviewWork(key, signal, async (workSignal) => {
					if ((k === 'image' || k === 'video') && d.thumbUrl) {
						try {
							const loc = await d.thumbUrl(e.id, { maxDim: dim });
							workSignal.throwIfAborted();
							if (loc?.url) {
								// The HTTP cache must share the file-version identity of IndexedDB.
								const remote = versionedThumbUrl(d, loc.url, token);
								const response = await fetch(remote, { ...withLocalAddressSpace(remote), signal: workSignal });
								if (!response.ok) throw new Error(`Could not load preview (${response.status})`);
								const poster = await response.blob();
								workSignal.throwIfAborted();
								if (key) void rememberThumb(key, poster);
								return poster;
							}
						} catch (err) {
							workSignal.throwIfAborted();
							if (!allowOriginal) throw err;
						}
						// A missing host poster must not download a remote original automatically.
						if (!allowOriginal) throw new Error('No host poster');
					}
					const original = await readExplorerBlob(d, e.id, { signal: workSignal });
					workSignal.throwIfAborted();
					const src = await generateThumbnail(original, k!, dim, e.name);
					try {
						const poster = await blobFromThumbSrc(src);
						workSignal.throwIfAborted();
						if (!poster) throw new Error('Could not render preview');
						if (key) void rememberThumb(key, poster);
						return poster;
					} finally { if (src.startsWith('blob:')) URL.revokeObjectURL(src); }
				});
				show(blob, 'fresh');
			} catch {
				if (signal.aborted) return;
				if (key) void rememberThumbFailure(key);
				failedLoad = { id: e.id, driver: d, dim, token, request, until: Date.now() + 60_000 };
				revoke();
				failed = true; loading = false;
			}
		}
		return () => { clearTimeout(timer); controller.abort(); };
	});

	let fallbackIcon = $derived(kind ? previewKindIcon(kind) : ('file' as FeIconName));
	let typeMark = $derived(!kind || (kind !== 'image' && kind !== 'video' && kind !== 'pdf'));
	const markIcon = $derived(Math.min(28, Math.max(14, Math.round(maxDim * 0.34))));
	const markLabel = $derived(Math.min(13, Math.max(8, Math.round(maxDim * 0.14))));
	function requestLoad(e: MouseEvent) {
		e.stopPropagation(); e.preventDefault(); requestedId = entry.id; requestVersion++;
	}
</script>

<div class="fe-thumb" use:observePreviewVisibility={(visible) => nearViewport = visible} style:--fe-thumb-max="{maxDim}px" data-testid="fe-thumb">
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
		<button type="button" class="fe-thumb-load fe-thumb-fallback" data-testid="fe-thumb-retry" aria-label="Retry preview" title="Retry preview" onclick={requestLoad}>
			<FeIcon name={fallbackIcon} size={Math.min(maxDim * 0.4, 32)} />
		</button>
	{:else if kind && kind !== 'text' && kind !== 'audio' && kind !== 'kb' && enabled && !shouldLoad}
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
		background: rgba(var(--overlay-rgb, 255, 255, 255), 0.08);
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
