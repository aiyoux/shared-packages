<script lang="ts">
	/**
	 * Compact chip portaled into the primary window header. Hidden until a
	 * new build is waiting; Refresh applies it (service worker + reload).
	 */
	import { onMount } from 'svelte';
	import { appUpdate } from './appUpdate.svelte.js';
	import { findUpdateBannerHost } from './appUpdate.js';

	let holder: HTMLDivElement | undefined = $state();
	let node: HTMLDivElement | undefined = $state();

	const visible = $derived(
		appUpdate.status === 'available' || appUpdate.status === 'applying'
	);

	function attach() {
		if (!node || typeof document === 'undefined') return;
		if (!visible) {
			if (holder && node.parentElement !== holder) holder.appendChild(node);
			return;
		}
		const host = findUpdateBannerHost(document);
		if (host) {
			if (node.parentElement !== host) host.appendChild(node);
			return;
		}
		if (holder && node.parentElement !== holder) holder.appendChild(node);
	}

	onMount(() => {
		const stop = appUpdate.start();
		attach();
		const obs = new MutationObserver(attach);
		obs.observe(document.documentElement, { childList: true, subtree: true });
		return () => {
			obs.disconnect();
			if (holder && node && node.parentElement !== holder) holder.appendChild(node);
			stop();
		};
	});

	$effect(() => {
		void visible;
		void node;
		attach();
	});
</script>

<div class="app-update-holder" bind:this={holder}>
	<div
		bind:this={node}
		class="app-update-banner"
		class:is-hidden={!visible}
		data-testid="app-update-banner"
		role="status"
		hidden={!visible}
	>
		<span class="copy">New update arrived</span>
		<button
			type="button"
			class="refresh"
			data-testid="app-update-refresh"
			disabled={appUpdate.status === 'applying'}
			onclick={() => void appUpdate.apply()}
		>
			{appUpdate.status === 'applying' ? 'Refreshing…' : 'Refresh'}
		</button>
	</div>
</div>

<style>
	.app-update-holder {
		display: contents;
	}
	.app-update-holder:has(> .app-update-banner:not(.is-hidden)) {
		display: block;
		position: fixed;
		top: 8px;
		right: 8px;
		z-index: 80;
	}
	.app-update-banner {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
		margin-inline: 8px;
		padding: 2px 8px 2px 10px;
		border: 1px solid color-mix(in srgb, var(--accent, #38bdf8) 55%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--surface, #1e293b) 82%, var(--accent, #38bdf8));
		color: var(--text-primary, #e2e8f0);
		font-size: 12px;
		line-height: 1.2;
		white-space: nowrap;
	}
	.app-update-banner.is-hidden {
		display: none;
	}
	.copy {
		opacity: 0.92;
	}
	.refresh {
		appearance: none;
		border: 1px solid color-mix(in srgb, var(--accent, #38bdf8) 70%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent, #38bdf8) 22%, transparent);
		color: inherit;
		font: inherit;
		font-weight: 600;
		padding: 2px 8px;
		cursor: pointer;
	}
	.refresh:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent, #38bdf8) 38%, transparent);
	}
	.refresh:disabled {
		opacity: 0.7;
		cursor: default;
	}
</style>
