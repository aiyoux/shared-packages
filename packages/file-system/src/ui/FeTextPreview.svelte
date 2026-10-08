<script lang="ts">
	import { canReadExplorerBlob, readExplorerBlob } from './explorerDriver.js';
	import type { ExplorerDriver, ExplorerEntry } from './explorerDriver.js';
	import { formatPreviewReadError } from './explorerError.js';
	import { decodeTextPreview } from './feThumbnails.js';
	import { readExplorerRange } from './rangedRead.js';

	/** At least this much of a remote file is read for its preview. */
	const RANGE_MIN_BYTES = 64 * 1024;

	let {
		entry,
		driver,
		maxChars = 16_000,
		variant = 'snippet',
		format = 'text'
	}: {
		entry: ExplorerEntry;
		driver: ExplorerDriver;
		maxChars?: number;
		variant?: 'snippet' | 'full';
		/** Knowledge Base pages show their title and content instead of the JSON envelope. */
		format?: 'text' | 'kb';
	} = $props();

	let text = $state('');
	let title = $state('');
	let truncated = $state(false);
	let loading = $state(true);
	let error = $state('');
	let binary = $state(false);

	$effect(() => {
		const e = entry;
		const d = driver;
		const cap = maxChars;
		const kb = format === 'kb';
		if (!canReadExplorerBlob(d)) {
			loading = false;
			error = 'Preview not available for this file type';
			return;
		}
		let cancelled = false;
		loading = true;
		error = '';
		text = '';
		title = '';
		truncated = false;
		binary = false;
		void (async () => {
			try {
				// A remote file sends only its start: a character is at most 4
				// UTF-8 bytes, so this always covers what the preview shows.
				const want = Math.max(RANGE_MIN_BYTES, cap * 4);
				// A KB page needs its complete JSON tree before extracting readable content.
				const part = !kb && d.rangeUrl ? await readExplorerRange(d, e.id, 0, want - 1).catch(() => null) : null;
				if (cancelled) return;
				if (part) {
					const more = (part.total ?? e.size ?? 0) > part.bytes.byteLength;
					// A cut through a multi-byte character decodes as U+FFFD; drop it.
					const decoded = await decodeTextPreview(new Blob([part.bytes]), cap);
					if (cancelled) return;
					text = more ? decoded.text.replace(/\uFFFD+$/, '') : decoded.text;
					truncated = decoded.truncated || more;
					binary = decoded.binary;
					loading = false;
					return;
				}
				const blob = await readExplorerBlob(d, e.id);
				if (cancelled) return;
				if (!blob) {
					text = '';
					loading = false;
					return;
				}
				if (kb) {
					const { parseKb, plaintext } = await import('@shared-packages/doc-model');
					const raw = await blob.text();
					if (cancelled) return;
					if (!raw.trim()) { loading = false; return; }
					const page = parseKb(raw);
					const body = plaintext(page);
					title = page.title;
					text = body.slice(0, cap);
					truncated = body.length > cap;
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
					error = formatPreviewReadError(err);
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
	class:kb={format === 'kb'}
	data-testid={variant === 'full' ? 'fe-float-text' : 'fe-preview-text'}
	data-format={format}
	data-truncated={truncated ? 'true' : undefined}
	data-binary={binary ? 'true' : undefined}
>
	{#if loading}
		<div class="fe-text-status">Loading…</div>
	{:else if error}
		<div class="fe-text-status error">{error}</div>
	{:else if binary}
		<div class="fe-text-status">This file is not plain text</div>
	{:else if !text && !title}
		<div class="fe-text-status muted">Empty file</div>
	{:else}
		{#if title}<h2 class="fe-kb-title">{title}</h2>{/if}
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
	.fe-kb-title {
		margin: 0;
		padding: 0.75rem 0.65rem 0;
		font-size: 1.1rem;
		color: var(--text-primary, #eee);
	}
	.full .fe-kb-title { padding: 1rem 1.25rem 0; }
	.kb .fe-text-body { font-family: inherit; }
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
