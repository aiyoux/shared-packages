<script lang="ts">
	import PanZoomViewport from './PanZoomViewport.svelte';

	let {
		src,
		title,
		alt = title,
		width = 0,
		height = 0,
		testidPrefix = 'image-preview',
		onClose
	}: {
		src: string;
		title: string;
		alt?: string;
		width?: number;
		height?: number;
		testidPrefix?: string;
		onClose: () => void;
	} = $props();

	let natural = $state({ w: 0, h: 0 });
	const contentW = $derived(width > 0 ? width : natural.w || 1);
	const contentH = $derived(height > 0 ? height : natural.h || 1);

	function onLoad(e: Event) {
		const img = e.currentTarget as HTMLImageElement;
		if (width > 0 && height > 0) return;
		natural = { w: img.naturalWidth || 1, h: img.naturalHeight || 1 };
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
	}
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="ipd-backdrop" data-testid="{testidPrefix}-dialog" onclick={onClose}>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="ipd-card"
		role="dialog"
		aria-modal="true"
		aria-label={title}
		tabindex="-1"
		onclick={(e) => e.stopPropagation()}
	>
		<div class="ipd-header">
			<span class="ipd-title" title={title}>{title}</span>
			<button
				type="button"
				class="ipd-close"
				data-testid="{testidPrefix}-close"
				aria-label="Close"
				onclick={onClose}
			>
				×
			</button>
		</div>
		<div class="ipd-body">
			<PanZoomViewport contentWidth={contentW} contentHeight={contentH} {testidPrefix}>
				<img src={src} {alt} onload={onLoad} />
			</PanZoomViewport>
		</div>
	</div>
</div>

<style>
	.ipd-backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgb(0 0 0 / 0.7);
	}
	.ipd-card {
		position: relative;
		display: flex;
		flex-direction: column;
		width: min(900px, calc(100vw - 2rem));
		height: min(90vh, 800px);
		background: var(--surface-2, #1a1a1a);
		border: 1px solid var(--line-hairline, #333);
		box-shadow: 0 16px 48px rgb(0 0 0 / 0.5);
		overflow: hidden;
	}
	.ipd-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--line-hairline, #333);
		flex-shrink: 0;
	}
	.ipd-title {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
		font-size: 0.9rem;
	}
	.ipd-close {
		flex-shrink: 0;
		background: none;
		border: none;
		color: var(--text-secondary, #aaa);
		cursor: pointer;
		padding: 0 6px;
		font-size: 1.4rem;
		line-height: 1;
	}
	.ipd-close:hover {
		color: var(--text-primary, #fff);
	}
	.ipd-body {
		flex: 1;
		min-height: 0;
		display: flex;
	}
</style>
