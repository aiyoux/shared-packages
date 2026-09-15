<script lang="ts">
	/**
	 * Zoom cluster matching the video player / sketcher bar:
	 * −  %  +  |  Fit  Width
	 */
	let {
		scale,
		mode = 'fit',
		testidPrefix = 'pz',
		onZoomIn,
		onZoomOut,
		onReset,
		onFit,
		onWidth
	}: {
		scale: number;
		mode?: 'fit' | 'width' | 'manual';
		testidPrefix?: string;
		onZoomIn: () => void;
		onZoomOut: () => void;
		onReset: () => void;
		onFit: () => void;
		onWidth: () => void;
	} = $props();

	const pct = $derived(`${Math.round(scale * 100)}%`);
</script>

<div class="pz-controls" data-testid="{testidPrefix}-zoom" role="group" aria-label="Zoom">
	<button
		type="button"
		class="pz-btn"
		title="Zoom out"
		aria-label="Zoom out"
		data-testid="{testidPrefix}-zoom-out"
		onclick={onZoomOut}
	>
		−
	</button>
	<button
		type="button"
		class="pz-btn pz-pct"
		title="Reset zoom and pan"
		aria-label="Reset zoom and pan"
		data-testid="{testidPrefix}-zoom-pct"
		onclick={onReset}
	>
		{pct}
	</button>
	<button
		type="button"
		class="pz-btn"
		title="Zoom in"
		aria-label="Zoom in"
		data-testid="{testidPrefix}-zoom-in"
		onclick={onZoomIn}
	>
		+
	</button>
	<span class="pz-divider" aria-hidden="true"></span>
	<button
		type="button"
		class="pz-btn pz-mode"
		class:active={mode === 'fit'}
		title="Fit in the window"
		aria-label="Fit"
		aria-pressed={mode === 'fit'}
		data-testid="{testidPrefix}-zoom-fit"
		onclick={onFit}
	>
		Fit
	</button>
	<button
		type="button"
		class="pz-btn pz-mode"
		class:active={mode === 'width'}
		title="Fit to width"
		aria-label="Fit width"
		aria-pressed={mode === 'width'}
		data-testid="{testidPrefix}-zoom-width"
		onclick={onWidth}
	>
		Width
	</button>
</div>

<style>
	.pz-controls {
		display: flex;
		align-items: center;
		flex: 0 0 auto;
		gap: 2px;
	}
	.pz-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 22px;
		height: 22px;
		padding: 0 6px;
		border: none;
		border-radius: 0;
		background: transparent;
		color: var(--text-secondary, #aaa);
		font-size: 0.72rem;
		font-weight: 600;
		cursor: pointer;
	}
	.pz-btn:hover {
		background: rgb(var(--border-rgb, 80 80 80) / 0.4);
		color: var(--text-primary, #fff);
	}
	.pz-btn.active {
		background: rgb(var(--accent-rgb, 56 189 248) / 0.25);
		color: var(--accent, #38bdf8);
	}
	.pz-pct {
		min-width: 42px;
		font-variant-numeric: tabular-nums;
	}
	.pz-divider {
		width: 1px;
		height: 16px;
		margin: 0 2px;
		background: var(--line-hairline, #333);
	}
</style>
