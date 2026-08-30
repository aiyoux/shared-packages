<script lang="ts">
	import { portal } from '../portal.js';

	let {
		editing = $bindable(false),
		portalTarget = '',
		testid = 'app-windows-btn',
		class: customClass = ''
	}: {
		editing?: boolean;
		portalTarget?: string;
		testid?: string;
		class?: string;
	} = $props();
</script>

<div class="aw-btn-park" class:parked={Boolean(portalTarget)}>
	<button
		type="button"
		class="aw-windows-btn {customClass}"
		class:active={editing}
		aria-pressed={editing}
		data-testid={testid}
		title="Windows"
		aria-label="Windows"
		data-tooltip="Edit windows"
		data-tooltip-pos="bottom-right"
		use:portal={portalTarget || undefined}
		onclick={() => {
			editing = !editing;
		}}
	>
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<rect width="18" height="18" x="3" y="3" rx="2" />
			<path d="M12 3v18" />
		</svg>
	</button>
</div>

<style>
	.aw-btn-park.parked {
		position: absolute;
		width: 0;
		height: 0;
		margin: 0;
		padding: 0;
		overflow: hidden;
		pointer-events: none;
	}

	.aw-windows-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: 1px solid var(--line-hairline, rgba(255, 255, 255, 0.12));
		border-radius: 4px;
		background: var(--surface-2, rgba(255, 255, 255, 0.06));
		color: var(--text-secondary, #a1a1aa);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.aw-windows-btn:hover {
		background: var(--surface-3, rgba(255, 255, 255, 0.12));
		color: var(--text-primary, #ffffff);
	}

	.aw-windows-btn.active {
		background: var(--accent, #3b82f6);
		color: #ffffff;
		border-color: var(--accent, #3b82f6);
	}
</style>
