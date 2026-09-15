<script lang="ts">
	import { canReadExplorerBlob, readExplorerBlob } from './explorerDriver.js';
	import type { ExplorerDriver, ExplorerEntry } from './explorerDriver.js';
	import { decodeTextPreview } from './feThumbnails.js';

	let {
		entry,
		driver,
		maxChars = 16_000,
		variant = 'snippet'
	}: {
		entry: ExplorerEntry;
		driver: ExplorerDriver;
		maxChars?: number;
		variant?: 'snippet' | 'full';
	} = $props();

	let text = $state('');
	let truncated = $state(false);
	let loading = $state(true);
	let error = $state('');
	let binary = $state(false);

	$effect(() => {
		const e = entry;
		const d = driver;
		const cap = maxChars;
		if (!canReadExplorerBlob(d)) {
			loading = false;
			error = 'Preview not available for this file type';
			return;
		}
		let cancelled = false;
		loading = true;
		error = '';
		text = '';
		truncated = false;
		binary = false;
		void (async () => {
			try {
				const blob = await readExplorerBlob(d, e.id);
				if (cancelled) return;
				if (!blob) {
					text = '';
					loading = false;
					return;
				}
				const decoded = await decodeTextPreview(blob, cap);
				if (cancelled) return;
				text = decoded.text;
				truncated = decoded.truncated;
				binary = decoded.binary;
				loading = false;
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
</script>

<div
	class="fe-text-preview"
	class:full={variant === 'full'}
	data-testid={variant === 'full' ? 'fe-float-text' : 'fe-preview-text'}
	data-truncated={truncated ? 'true' : undefined}
	data-binary={binary ? 'true' : undefined}
>
	{#if loading}
		<div class="fe-text-status">Loading…</div>
	{:else if error}
		<div class="fe-text-status error">{error}</div>
	{:else if binary}
		<div class="fe-text-status">This file is not plain text</div>
	{:else if !text}
		<div class="fe-text-status muted">Empty file</div>
	{:else}
		<pre class="fe-text-body">{text}</pre>
		{#if truncated}
			<p class="fe-text-trunc">Showing the first {maxChars.toLocaleString()} characters</p>
		{/if}
	{/if}
</div>

<style>
	.fe-text-preview {
		width: 100%;
		min-height: 4rem;
		max-height: 11rem;
		overflow: auto;
		text-align: left;
	}
	.fe-text-preview.full {
		max-height: none;
		height: 100%;
		display: flex;
		flex-direction: column;
	}
	.fe-text-body {
		margin: 0;
		padding: 0.5rem 0.65rem;
		font: inherit;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.8rem;
		line-height: 1.45;
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--text-primary, #eee);
	}
	.full .fe-text-body {
		flex: 1;
		padding: 1rem 1.25rem;
		font-size: 0.9rem;
	}
	.fe-text-status {
		padding: 0.75rem;
		font-size: 0.85rem;
		color: var(--text-secondary, #aaa);
	}
	.fe-text-status.error {
		color: var(--cat-red-soft, #e66);
	}
	.fe-text-status.muted {
		font-style: italic;
	}
	.fe-text-trunc {
		margin: 0;
		padding: 0.25rem 0.65rem 0.5rem;
		font-size: 0.75rem;
		color: var(--text-muted, #888);
	}
</style>
