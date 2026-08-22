<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
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
	let kind = $state<PreviewKind | null>(null);
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
		kind = getPreviewKind(e);

		// Captured, not re-read: the async block below runs after this effect
		// returns, and a narrowing on `d.readBlob` does not survive into it —
		// the driver is a mutable reference and TS cannot know it still has the
		// method by then.
		const readBlob = d.readBlob;
		if (!en || !kind || !readBlob) {
			revoke();
			loading = false;
			failed = false;
			return;
		}

		// Skip if same entry
		if (currentId === e.id) return;
		currentId = e.id;

		let cancelled = false;
		revoke();
		loading = true;
		failed = false;

		(async () => {
			try {
				const blob = await readBlob.call(d, e.id);
				if (cancelled || !blob) return;
				const thumbUrl = await generateThumbnail(blob, kind!, maxDim);
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
