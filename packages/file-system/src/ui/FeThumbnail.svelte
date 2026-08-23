<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import FeIcon from './FeIcon.svelte';
	import type { FeIconName } from './feIcons.js';
	import {
		getPreviewKind,
		generateThumbnail,
		previewKindIcon,
		type PreviewKind
	} from './feThumbnails.js';
	import type { ExplorerDriver, ExplorerEntry } from './explorerDriver.js';

	let {
		entry,
		driver,
		maxDim = 96,
		enabled = true
	}: {
		entry: ExplorerEntry;
		driver: ExplorerDriver;
		maxDim?: number;
		enabled?: boolean;
	} = $props();

	let url = $state<string | null>(null);
	let loading = $state(false);
	let failed = $state(false);
	let kind = $derived(getPreviewKind(entry));
	let currentId = '';

	onDestroy(() => {
		revoke();
	});

	function revoke() {
		if (url && url.startsWith('blob:')) {
			URL.revokeObjectURL(url);
		}
		// data: URLs don't need revocation
		url = null;
	}

	$effect(() => {
		// Re-read entry/driver/enabled so effect re-runs on change
		const e = entry;
		const d = driver;
		const en = enabled;
		// `kind` is a $derived read here, not written — writing it from inside
		// this effect and then reading it back in the same run used to make
		// the effect depend on its own write, forcing exactly one redundant
		// re-run right after mount. That re-run raced with (and cancelled) the
		// in-flight blob fetch below, and since `currentId` was already set by
		// the first run, the redundant run bailed out without restarting the
		// fetch — leaving the thumbnail stuck on "loading" forever.
		const k = kind;

		// Captured, not re-read: the async block below runs after this effect
		// returns, and a narrowing on `d.readBlob` does not survive into it —
		// the driver is a mutable reference and TS cannot know it still has the
		// method by then.
		const readBlob = d.readBlob;
		if (!en || !k || !readBlob) {
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

		// Skip if same entry
		if (currentId === e.id) return;
		currentId = e.id;

		let cancelled = false;
		// untrack: see comment above.
		untrack(revoke);
		loading = true;
		failed = false;

		(async () => {
			try {
				const blob = await readBlob.call(d, e.id);
				if (cancelled || !blob) return;
				const thumbUrl = await generateThumbnail(blob, k, maxDim);
				if (cancelled) return;
				url = thumbUrl;
				loading = false;
			} catch {
				if (!cancelled) {
					failed = true;
					loading = false;
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	});

	let fallbackIcon = $derived(
		kind ? previewKindIcon(kind) : ('file' as FeIconName)
	);
</script>

{#if url}
	<img class="fe-thumb-img" src={url} alt={entry.name} loading="lazy" />
{:else if loading}
	<div class="fe-thumb-loading" aria-label="Loading preview">
		<div class="fe-thumb-spinner"></div>
	</div>
{:else if failed}
	<div class="fe-thumb-fallback">
		<FeIcon name={fallbackIcon} size={Math.min(maxDim * 0.4, 32)} />
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

<style>
	.fe-thumb-img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		display: block;
	}
	.fe-thumb-loading,
	.fe-thumb-fallback {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted, #888);
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
