<script lang="ts">
	import X from '@lucide/svelte/icons/x';
	import {
		STICKER_STYLES,
		getStickerVariant,
		stickersForStyle,
		type StickerMojiId,
		type StickerStyleId
	} from './catalog';
	import StickerGlyph from './StickerGlyph.svelte';

	let {
		variant = 'page',
		onInsert,
		onClose
	}: {
		variant?: 'page' | 'modal';
		onInsert?: (stickerId: string) => void;
		onClose?: () => void;
	} = $props();

	let styleId = $state<StickerStyleId>('style-1');
	let mojiId = $state<StickerMojiId>('happy');

	const grid = $derived(stickersForStyle(styleId));
	const preview = $derived(getStickerVariant(mojiId, styleId) ?? null);

	function selectStyle(next: StickerStyleId) {
		styleId = next;
	}

	function handleInsert() {
		if (preview && onInsert) onInsert(preview.id);
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose?.();
	}
</script>

<svelte:window onkeydown={handleKeyDown} />

<div
	class="picker"
	class:modal={variant === 'modal'}
	class:page={variant === 'page'}
	data-testid="sticker-picker"
>
	{#if variant === 'modal'}
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="backdrop" onclick={() => onClose?.()} role="presentation"></div>
	{/if}

	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
	<section
		class="sheet"
		onclick={(e) => e.stopPropagation()}
		role="dialog"
		aria-modal={variant === 'modal' ? 'true' : undefined}
		aria-labelledby="sticker-library-title"
	>
		<header class="header">
			<h2 id="sticker-library-title">Sticker Library</h2>
			{#if onClose}
				<button class="close-btn" onclick={() => onClose?.()} title="Close" aria-label="Close sticker library">
					<X size={20} />
				</button>
			{/if}
		</header>

		<div class="style-tabs" role="tablist" aria-label="Sticker style">
			{#each STICKER_STYLES as style (style.id)}
				<button
					type="button"
					role="tab"
					class="style-tab"
					class:active={styleId === style.id}
					aria-selected={styleId === style.id}
					data-testid="sticker-style-{style.id}"
					onclick={() => selectStyle(style.id)}
				>
					{style.label}
				</button>
			{/each}
		</div>

		<div class="body">
			<div class="grid" role="listbox" aria-label="Stickers">
				{#each grid as sticker (sticker.id)}
					<button
						type="button"
						class="cell"
						class:selected={mojiId === sticker.mojiId}
						role="option"
						aria-selected={mojiId === sticker.mojiId}
						aria-label={sticker.name}
						data-testid="sticker-moji-{sticker.mojiId}"
						onclick={() => (mojiId = sticker.mojiId)}
					>
						<div class="cell-glyph">
							<StickerGlyph {sticker} />
						</div>
					</button>
				{/each}
			</div>

			<div class="preview">
				{#if preview}
					<div class="preview-board">
						<StickerGlyph sticker={preview} />
					</div>
					<div class="preview-meta">
						<h3>{preview.name}</h3>
						<p>{preview.description}</p>
					</div>
					{#if onInsert}
						<button type="button" class="insert-btn" onclick={handleInsert}>Insert Sticker</button>
					{/if}
				{/if}
			</div>
		</div>
	</section>
</div>

<style>
	.picker.page {
		width: 100%;
		max-width: 860px;
	}

	.picker.modal {
		position: fixed;
		inset: 0;
		z-index: var(--z-dialog-priority, 80);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.backdrop {
		position: absolute;
		inset: 0;
		background: rgba(6, 8, 14, 0.62);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
	}

	.sheet {
		position: relative;
		background: var(--bg-card, #16161e);
		border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
		border-radius: var(--radius-lg, 16px);
		width: min(880px, 95vw);
		max-height: min(680px, 88dvh);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		box-shadow: 0 24px 64px rgba(0, 0, 0, 0.35);
	}

	.picker.page .sheet {
		width: 100%;
		max-height: none;
		box-shadow: none;
	}

	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 20px 8px;
	}

	.header h2 {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 650;
		color: var(--text-primary, #f4f4f5);
	}

	.close-btn {
		background: transparent;
		border: none;
		color: var(--text-muted, #94a3b8);
		width: 32px;
		height: 32px;
		border-radius: 8px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}

	.close-btn:hover {
		background: var(--bg-card-hover, rgba(255, 255, 255, 0.06));
		color: var(--text-primary, #fff);
	}

	.style-tabs {
		display: flex;
		gap: 6px;
		padding: 0 20px 12px;
	}

	.style-tab {
		border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
		background: transparent;
		color: var(--text-secondary, #cbd5e1);
		border-radius: 999px;
		padding: 6px 12px;
		font: inherit;
		font-size: 0.82rem;
		font-weight: 600;
		cursor: pointer;
	}

	.style-tab.active {
		background: var(--accent, #6366f1);
		border-color: var(--accent, #6366f1);
		color: white;
	}

	.body {
		display: grid;
		grid-template-columns: minmax(180px, 0.9fr) 1.3fr;
		gap: 16px;
		padding: 0 20px 20px;
		min-height: 0;
		flex: 1;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
		align-content: start;
		gap: 10px;
	}

	.cell {
		aspect-ratio: 1;
		border: 1px solid transparent;
		background: var(--overlay-light, rgba(255, 255, 255, 0.03));
		border-radius: 14px;
		padding: 8px;
		cursor: pointer;
	}

	.cell:hover {
		border-color: var(--border, rgba(255, 255, 255, 0.12));
	}

	.cell.selected {
		border-color: var(--accent, #6366f1);
		background: var(--accent-subtle, rgba(99, 102, 241, 0.14));
	}

	.cell-glyph {
		width: 100%;
		height: 100%;
	}

	.preview {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.preview-board {
		flex: 1;
		min-height: 220px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 28px;
		border-radius: 16px;
		border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
		background:
			radial-gradient(circle at 30% 20%, rgba(255, 255, 255, 0.16), transparent 42%),
			linear-gradient(180deg, #f6f0e4 0%, #e7dcc8 100%);
	}

	.preview-board :global(svg) {
		width: min(260px, 72%);
		height: auto;
		filter: drop-shadow(0 10px 18px rgba(40, 24, 8, 0.22));
	}

	.preview-meta {
		text-align: center;
		margin-top: 14px;
	}

	.preview-meta h3 {
		margin: 0 0 4px;
		font-size: 1rem;
		color: var(--text-primary, #f4f4f5);
	}

	.preview-meta p {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-secondary, #94a3b8);
	}

	.insert-btn {
		margin-top: 14px;
		padding: 12px 24px;
		background: var(--accent, #6366f1);
		border: none;
		border-radius: 12px;
		color: white;
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	@media (max-width: 640px) {
		.body {
			grid-template-columns: 1fr;
		}
		.grid {
			grid-template-columns: repeat(4, 1fr);
		}
		.preview-board {
			min-height: 180px;
		}
	}
</style>
