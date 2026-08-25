<script lang="ts">
	/**
	 * Combined (i) for the dual-pane chrome: current connection(s) + the
	 * copy route between them. Replaces the per-switcher info buttons.
	 */
	import FeIcon from './FeIcon.svelte';
	import { capabilityRows, connectionKindNote } from './connectionInfo.js';
	import type { CopyAcrossPath } from './copyAcross.js';
	import type { ExplorerCapabilities } from './explorerDriver.js';
	export type PairSide = {
		side: string;
		label: string;
		kind: string;
		capabilities?: ExplorerCapabilities;
	};

	let {
		left,
		right = null,
		copyOut = null,
		copyIn = null,
		idleNote = null
	}: {
		left: PairSide;
		right?: PairSide | null;
		copyOut?: CopyAcrossPath | null;
		copyIn?: CopyAcrossPath | null;
		idleNote?: string | null;
	} = $props();

	const dual = $derived(Boolean(right));
	const sameConn = $derived(Boolean(right && left.label === right.label && left.kind === right.kind));
	const aria = $derived(
		dual
			? `Connections: ${left.label} and ${right!.label}`
			: `Connection: ${left.label}`
	);
</script>

<div class="pair-info-wrap" data-testid="fe-pair-info">
	<button
		type="button"
		class="pair-info"
		data-testid="conn-caps-info"
		aria-label={aria}
		aria-describedby="conn-caps-tip"
	>
		<FeIcon name="info" size={14} />
	</button>
	<div class="pair-tip" id="conn-caps-tip" data-testid="conn-caps-tooltip" role="tooltip">
		<p class="caps-title">
			{#if dual && !sameConn}
				{left.label} ↔ {right!.label}
			{:else if dual}
				{left.label}
				<span class="caps-sub">both panes</span>
			{:else}
				{left.label}
			{/if}
		</p>

		<section class="side" data-testid="conn-info-left">
			{#if dual}
				<p class="side-kicker">{left.side}</p>
			{/if}
			<p class="side-label">{left.label}</p>
			<p class="caps-note">{connectionKindNote(left.kind)}</p>
			<ul class="caps-list">
				{#each capabilityRows(left.capabilities) as row (row.label)}
					<li class:on={row.on} data-on={row.on ? '1' : '0'}>
						<span class="caps-mark" aria-hidden="true">{row.on ? '✓' : '–'}</span>
						{row.label}
					</li>
				{/each}
			</ul>
		</section>

		{#if right && !sameConn}
			<section class="side" data-testid="conn-info-right">
				<p class="side-kicker">{right.side}</p>
				<p class="side-label">{right.label}</p>
				<p class="caps-note">{connectionKindNote(right.kind)}</p>
				<ul class="caps-list">
					{#each capabilityRows(right.capabilities) as row (row.label)}
						<li class:on={row.on} data-on={row.on ? '1' : '0'}>
							<span class="caps-mark" aria-hidden="true">{row.on ? '✓' : '–'}</span>
							{row.label}
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<div class="copy-path" data-testid="conn-copy-path">
			<p class="caps-title copy-path-title">Copy path</p>
			{#if idleNote}
				<p class="copy-path-summary">{idleNote}</p>
			{:else}
				{#if copyOut}
					<p class="copy-path-dir">
						{left.label} → {right?.label ?? 'the other pane'}
					</p>
					<p class="copy-path-summary" data-copy-kind={copyOut.kind}>{copyOut.summary}</p>
					<p class="copy-path-detail">{copyOut.detail}</p>
				{/if}
				{#if copyIn && right}
					<p class="copy-path-dir">
						{right.label} → {left.label}
					</p>
					<p class="copy-path-summary" data-copy-kind={copyIn.kind}>{copyIn.summary}</p>
					<p class="copy-path-detail">{copyIn.detail}</p>
				{/if}
			{/if}
			<p class="copy-path-detail">
				Folder copy walks the tree and copies each item. The destination must support new folders
				(not In memory).
			</p>
		</div>
	</div>
</div>

<style>
	.pair-info-wrap {
		position: relative;
		flex-shrink: 0;
	}
	.pair-info {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--control-h-sm, 1.75rem);
		height: var(--control-h-sm, 1.75rem);
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text-secondary);
		cursor: help;
		transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
	}
	.pair-info:hover,
	.pair-info-wrap:focus-within .pair-info {
		background: rgb(var(--overlay-rgb) / 0.06);
		color: var(--text-primary);
	}
	.pair-tip {
		display: none;
		position: absolute;
		z-index: 80;
		top: calc(100% + 6px);
		left: 0;
		width: min(22rem, 92vw);
		max-height: min(70vh, 36rem);
		overflow: auto;
		padding: 0.6rem 0.7rem 0.55rem;
		border: 1px solid var(--line-hairline);
		background: var(--surface-2);
		color: var(--text-primary);
		box-shadow: 0 10px 28px rgb(var(--scrim-rgb) / 0.45);
		font-size: 0.78rem;
		line-height: 1.35;
	}
	.pair-info-wrap:hover .pair-tip,
	.pair-info-wrap:focus-within .pair-tip {
		display: block;
	}
	.caps-title {
		margin: 0 0 0.35rem;
		font-weight: 700;
		font-size: 0.84rem;
	}
	.caps-sub {
		margin-left: 0.35rem;
		font-weight: 500;
		font-size: 0.7rem;
		opacity: 0.65;
	}
	.side {
		margin: 0 0 0.55rem;
		padding-bottom: 0.45rem;
		border-bottom: 1px solid var(--line-hairline);
	}
	.side-kicker {
		margin: 0 0 0.1rem;
		font-size: 0.68rem;
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		opacity: 0.65;
	}
	.side-label {
		margin: 0 0 0.15rem;
		font-weight: 650;
	}
	.caps-note {
		margin: 0 0 0.4rem;
		opacity: 0.75;
		font-size: 0.72rem;
	}
	.caps-list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 0.1rem;
	}
	.caps-list li {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		opacity: 0.45;
	}
	.caps-list li.on {
		opacity: 1;
	}
	.caps-mark {
		width: 0.85rem;
		text-align: center;
		color: var(--accent);
		font-weight: 700;
	}
	.caps-list li:not(.on) .caps-mark {
		color: var(--text-muted);
	}
	.copy-path-title {
		margin-bottom: 0.3rem;
	}
	.copy-path-dir {
		margin: 0.35rem 0 0.1rem;
		font-weight: 650;
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		opacity: 0.7;
	}
	.copy-path-summary {
		margin: 0;
		font-weight: 600;
	}
	.copy-path-detail {
		margin: 0.15rem 0 0;
		opacity: 0.75;
		font-size: 0.72rem;
	}
</style>
