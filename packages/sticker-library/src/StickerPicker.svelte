<script lang="ts">
	import X from '@lucide/svelte/icons/x';
	import {
		STICKER_MOJIS,
		STICKER_STYLES,
		getStickerById,
		stickersMatching,
		type StickerMojiFilter,
		type StickerMojiId,
		type StickerStyleFilter,
		type StickerTemplate
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

	let styleFilter = $state<StickerStyleFilter>('all');
	let mojiFilter = $state<StickerMojiFilter>('all');
	let selectedId = $state('happy:style-1');

	const grid = $derived(stickersMatching({ styleId: styleFilter, mojiId: mojiFilter }));
	const preview = $derived(getStickerById(selectedId) ?? grid[0] ?? null);

	$effect(() => {
		const ids = new Set(grid.map((s) => s.id));
		if (ids.has(selectedId)) return;
		const current = getStickerById(selectedId);
		const sameMoji = current ? grid.find((s) => s.mojiId === current.mojiId) : undefined;
		selectedId = sameMoji?.id ?? grid[0]?.id ?? selectedId;
	});

	function mojiLabel(id: StickerMojiId): string {
		return STICKER_MOJIS.find((m) => m.id === id)?.name ?? id;
	}

	function selectCell(sticker: StickerTemplate) {
		selectedId = sticker.id;
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
		aria-label="Sticker Library"
	>
		{#if onClose}
			<header class="header">
				<button class="close-btn" onclick={() => onClose?.()} title="Close" aria-label="Close sticker library">
					<X size={20} />
				</button>
			</header>
		{/if}

		<div class="filters">
			<div class="filter-row">
				<span class="filter-label">Style</span>
				<div class="seg" role="tablist" aria-label="Sticker style">
					<button
						type="button"
						role="tab"
						class:active={styleFilter === 'all'}
						aria-selected={styleFilter === 'all'}
						data-testid="sticker-style-all"
						onclick={() => (styleFilter = 'all')}
					>
						All
					</button>
					{#each STICKER_STYLES as style (style.id)}
						<button
							type="button"
							role="tab"
							class:active={styleFilter === style.id}
							aria-selected={styleFilter === style.id}
							data-testid="sticker-style-{style.id}"
							onclick={() => (styleFilter = style.id)}
						>
							{style.label}
						</button>
					{/each}
				</div>
			</div>
			<div class="filter-row">
				<span class="filter-label">Sticker</span>
				<div class="seg" role="tablist" aria-label="Sticker">
					<button
						type="button"
						role="tab"
						class:active={mojiFilter === 'all'}
						aria-selected={mojiFilter === 'all'}
						data-testid="sticker-face-all"
						onclick={() => (mojiFilter = 'all')}
					>
						All
					</button>
					{#each STICKER_MOJIS as moji (moji.id)}
						<button
							type="button"
							role="tab"
							class:active={mojiFilter === moji.id}
							aria-selected={mojiFilter === moji.id}
							data-testid="sticker-face-{moji.id}"
							onclick={() => (mojiFilter = moji.id)}
						>
							{moji.name}
						</button>
					{/each}
				</div>
			</div>
		</div>

		<div class="body">
			<div class="grid" role="listbox" aria-label="Stickers">
				{#each grid as sticker (sticker.id)}
					<button
						type="button"
						class="cell"
						class:selected={selectedId === sticker.id}
						role="option"
						aria-selected={selectedId === sticker.id}
						aria-label={mojiLabel(sticker.mojiId)}
						data-testid="sticker-cell-{sticker.mojiId}-{sticker.styleId}"
						onclick={() => selectCell(sticker)}
					>
						<div class="cell-glyph">
							<StickerGlyph {sticker} label={mojiLabel(sticker.mojiId)} />
						</div>
					</button>
				{/each}
			</div>

			<div class="preview">
				{#if preview}
					<div class="preview-board">
						<StickerGlyph sticker={preview} label={mojiLabel(preview.mojiId)} />
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
		background: transparent;
		border: none;
		border-radius: 0;
		width: min(880px, 95vw);
		max-height: min(680px, 88dvh);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		box-shadow: none;
	}

	.picker.page .sheet {
		width: 100%;
		max-height: none;
		overflow: visible;
	}

	.header {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		padding: 8px 8px 8px;
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

	.filters {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 0 20px 14px;
	}

	.filter-row {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}

	.filter-label {
		flex: 0 0 4.2rem;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted, var(--text-secondary, #6b7785));
	}

	.seg {
		display: flex;
		flex-wrap: wrap;
		align-items: stretch;
		gap: 3px;
		padding: 3px;
		min-width: 0;
		flex: 1;
		background: var(--surface-2, var(--bg-secondary, #0c111c));
		border: 1px solid var(--line-hairline, var(--border, rgba(255, 255, 255, 0.1)));
		border-radius: var(--hud-radius, var(--radius-md, 4px));
	}

	.seg > button {
		flex: 1;
		min-width: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 6px 10px;
		border: 0;
		border-radius: var(--hud-radius, var(--radius-md, 4px));
		background: transparent;
		color: var(--text-secondary, #9aa8b6);
		font: inherit;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
	}

	.seg > button:hover {
		color: var(--text-primary, #e8eef4);
	}

	.seg > button.active,
	.seg > button[aria-selected='true'] {
		background: var(--accent, #38bdf8);
		color: var(--color-primary-foreground, #020617);
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
		border-color: var(--accent, #38bdf8);
		background: color-mix(in srgb, var(--accent, #38bdf8) 16%, transparent);
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

	.insert-btn {
		margin-top: 14px;
		height: var(--control-h, 32px);
		padding: 0 1rem;
		background: var(--accent, #38bdf8);
		border: none;
		border-radius: var(--radius-md, 4px);
		color: var(--color-primary-foreground, #020617);
		font: inherit;
		font-size: 12px;
		font-weight: 500;
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
