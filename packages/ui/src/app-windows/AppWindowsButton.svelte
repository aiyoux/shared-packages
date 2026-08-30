<script lang="ts">
	import { portalToPaneWindowHeader } from '../pane-layout/chrome.js';
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

	function portalAction(node: HTMLElement) {
		if (portalTarget) {
			const res = portal(node, portalTarget);
			if (res) return res;
		}
		return portalToPaneWindowHeader(node);
	}
</script>

<div
	class="aw-btn-wrap"
	class:parked={Boolean(portalTarget)}
	use:portalAction
>
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
	.aw-btn-wrap {
		display: inline-flex;
		align-items: center;
		visibility: hidden;
	}

	.aw-btn-wrap:global(.in-overlay),
	.aw-btn-wrap:global(.in-chrome) {
		visibility: visible;
	}

	.aw-btn-wrap:global(.in-overlay) {
		position: absolute;
		top: calc(12px + env(safe-area-inset-top, 0px));
		left: calc(12px + env(safe-area-inset-left, 0px));
		z-index: var(--z-popover, 40);
	}

	.aw-btn-wrap:global(.in-chrome) {
		position: relative;
		z-index: 3;
		height: 100%;
	}

	.aw-windows-btn {
		box-sizing: border-box;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 38px;
		height: 38px;
		padding: 0;
		border: 1px solid var(--border, var(--line-strong, rgba(255, 255, 255, 0.12)));
		border-radius: var(--radius-md, 6px);
		background: var(--bg-chrome, rgba(18, 18, 24, 0.94));
		color: var(--text-primary);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	:global(.in-chrome) .aw-windows-btn {
		width: var(--control-h-sm, 26px);
		height: var(--control-h-sm, 26px);
		min-width: var(--control-h-sm, 26px);
		background: transparent;
		border: 1px solid transparent;
		border-radius: 0;
		color: var(--text-secondary);
	}

	:global(.in-chrome) .aw-windows-btn:hover,
	:global(.in-chrome) .aw-windows-btn:focus-visible {
		background: var(--surface-3);
		color: var(--text-primary);
		outline: none;
	}

	:global(.in-chrome) .aw-windows-btn.active {
		background: var(--accent);
		color: var(--accent-contrast, #ffffff);
		border-color: var(--accent);
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
