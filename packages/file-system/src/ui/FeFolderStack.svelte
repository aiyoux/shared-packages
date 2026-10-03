<script lang="ts">
	import { untrack } from 'svelte';
	import FeIcon from './FeIcon.svelte';
	import FeThumbnail from './FeThumbnail.svelte';
	import { explorerThumbsAreEager } from './explorerDriver.js';
	import { getPreviewKind } from './feThumbnails.js';
	import type { ExplorerDriver, ExplorerEntry } from './explorerDriver.js';

	let {
		entry,
		driver,
		enabled = true,
		fallbackSize = 48,
		maxDim = 64
	}: {
		entry: ExplorerEntry;
		driver: ExplorerDriver;
		/** The global Show-preview gate; stacks are thumbnails too. */
		enabled?: boolean;
		/** Fallback folder icon, when the stack is empty or unavailable. */
		fallbackSize?: number;
		maxDim?: number;
	} = $props();

	const STACK_SLOTS = 3;

	/** Auto-blob drivers only: a folder deck must not quietly download every B2
	 *  child that happens to be on screen. Server-thumb and local-class drivers
	 *  qualify (see FeThumbnail's eager rule). */
	const eager = explorerThumbsAreEager(driver);

	/** Children picked for the deck: the first tiles in driver order. */
	let listings = $state<Map<string, ExplorerEntry[]>>(new Map());

	/** Folders with a listing in flight. Plain set: an effect must never write
	 *  the state it guards — that reschedules itself into an update loop. */
	const pending = new Set<string>();

	$effect(() => {
		const id = entry.id;
		const d = driver;
		const en = enabled;
		if (!en || !eager) return;
		untrack(() => {
			if (pending.has(id) || listings.has(id)) return;
			pending.add(id);
		});
		void (async () => {
			try {
				// `probe` — a background look-ahead the user did not ask for:
				// drivers tell the backend not to log a refused folder as an error.
				const result = await d.list({ parentId: id, probe: true });
				const withThumb = result.entries.filter(
					(k) => k.kind !== 'folder' && getPreviewKind(k)
				);
				const rest = result.entries.filter((k) => !withThumb.includes(k));
				const now = new Map(listings);
				now.set(id, [...withThumb, ...rest].slice(0, STACK_SLOTS));
				listings = now;
			} catch {
				// No entry → fallback icon. The cache stays untouched so a later
				// remount (or an enable toggle) can retry.
			}
			pending.delete(id);
		})();
		// No teardown: landed listings are kept for remounts, in-flight ones are
		// harmless to complete (the write is just unreachable once destroyed).
	});

	const kids = $derived(listings.get(entry.id) ?? []);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
	class="fe-folder-stack"
	class:empty={!kids.length}
	data-testid="fe-folder-stack"
	data-stack-for={entry.id}
>
	{#if kids.length}
		{#each kids as kid, i (kid.id)}
			<span class="fe-stack-tile" style="left: {i * 16}%; top: {i * 16}%; z-index: {kids.length - i}">
				<FeThumbnail entry={kid} {driver} maxDim={maxDim} enabled={enabled} />
			</span>
		{/each}
	{:else}
		<span class="fe-stack-fallback">
			<FeIcon name="folder" size={fallbackSize} />
		</span>
	{/if}
</span>

<style>
	.fe-folder-stack {
		position: relative;
		width: 100%;
		height: 100%;
		display: block;
	}
	.fe-stack-tile {
		position: absolute;
		width: 70%;
		height: 70%;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		border: 1px solid var(--line-hairline, rgba(255, 255, 255, 0.12));
		border-radius: 3px;
		background: var(--surface-3, rgba(255, 255, 255, 0.08));
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.25);
	}
	.fe-stack-tile :global(.fe-thumb) {
		background: transparent;
	}
	.fe-stack-fallback {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
	}
</style>