<script lang="ts">
	import { anchoredPopup } from '@shared-packages/design-system';
	/**
	 * Compact ops bar for one file-manager window. Reads the central ops list
	 * and keeps rows whose `windowId` is this window (a hub pane), so another
	 * pane in the same tab does not show them.
	 */
	import { onMount, untrack } from 'svelte';
	import FeIcon from './FeIcon.svelte';
	import { requestArchiveDialogShow } from './archiveReshow.js';
	import {
		isActiveOp,
		opsService,
		type OpProgress,
		type OpRecord,
		type OpsService
	} from '../services/ops.js';
	import { stackedStageLabel, stagePercent } from './stackProgress.js';

	interface Props {
		windowId: string;
	}

	let { windowId }: Props = $props();

	let service: OpsService | null = null;
	let tick = $state(0);
	let open = $state(false);
	let rootEl = $state<HTMLDivElement | null>(null);
	const seen = new Set<string>();

	function noteActive() {
		if (!service || !windowId) return;
		for (const op of service.list()) {
			if (op.windowId === windowId && isActiveOp(op)) seen.add(op.id);
		}
	}

	function refresh() {
		noteActive();
		tick += 1;
	}

	onMount(() => {
		let stop = () => {};
		let dead = false;
		void opsService()
			.then((svc) => {
				if (dead) return;
				service = svc;
				stop = svc.subscribe(refresh);
				refresh();
			})
			.catch((error) => console.error('Could not read operations', error));
		return () => {
			dead = true;
			stop();
		};
	});

	$effect(() => {
		void windowId;
		untrack(() => {
			seen.clear();
			refresh();
		});
	});

	type RowStatus = 'active' | 'done' | 'failed' | 'cancelled';

	function rowStatus(op: OpRecord): RowStatus {
		if (op.state === 'failed') return 'failed';
		if (op.state === 'cancelled' || op.state === 'stopped') return 'cancelled';
		if (op.state === 'done' || op.state === 'landed') return 'done';
		return 'active';
	}

	function viewOf(op: OpRecord) {
		const progress: OpProgress | undefined = service?.progressOf(op.id);
		const status = rowStatus(op);
		const behind = progress?.done ?? 0;
		const total = progress?.total ?? 0;
		const ahead = progress?.ahead ?? behind;
		const done = status === 'done';
		return {
			op,
			name: op.title,
			status,
			done,
			ahead,
			behind,
			total,
			label: stackedStageLabel({
				ahead,
				behind,
				size: total,
				done,
				status: status === 'active' ? undefined : status
			}),
			route: progress?.route ?? op.where.route,
			ice: progress?.ice,
			icePath: progress?.icePath,
			note: progress?.note,
			error: op.error
		};
	}

	function iceAttr(ice: OpProgress['ice'], icePath: OpProgress['icePath']): string | undefined {
		if (ice === 'failed') return 'failed';
		if (icePath === 'host' || icePath === 'stun') return icePath;
		if (ice === 'checking' || ice === 'connected') return 'checking';
		return ice;
	}

	const rows = $derived.by(() => {
		void tick;
		if (!service || !windowId) return [];
		return service
			.list()
			.filter((op) => op.windowId === windowId && (isActiveOp(op) || seen.has(op.id)))
			.map(viewOf);
	});

	const latest = $derived(rows.find((row) => row.status === 'active') ?? rows[0] ?? null);
	const hasFinished = $derived(rows.some((row) => row.status !== 'active'));

	function onChipClick() {
		if (latest && requestArchiveDialogShow(latest.op.id)) {
			open = false;
			return;
		}
		open = !open;
	}

	async function dismissRow(op: OpRecord) {
		const svc = service;
		if (!svc) return;
		if (isActiveOp(op)) svc.cancel(op.id);
		else await svc.dismiss(op.id);
	}

	async function dismissFinished() {
		const svc = service;
		if (!svc) return;
		for (const row of rows) {
			if (row.status !== 'active') await svc.dismiss(row.op.id);
		}
		open = false;
	}
</script>

{#if latest}
	<div class="chip-wrap dpe-copy-chip" bind:this={rootEl} data-testid="fe-op-progress" data-window={windowId}>
		<button
			type="button"
			class="chip"
			class:failed={latest.status === 'failed'}
			class:cancelled={latest.status === 'cancelled'}
			class:done={latest.done}
			data-testid="fe-op-progress-row"
			data-status={latest.status}
			data-name={latest.name}
			data-copy-hop={latest.route}
			data-ice={iceAttr(latest.ice, latest.icePath)}
			data-ice-path={latest.icePath}
			aria-expanded={open}
			aria-haspopup="true"
			title={latest.error || latest.note || latest.name}
			onclick={onChipClick}
		>
			<div
				class="bar dpe-copy-bar"
				role="progressbar"
				aria-valuenow={stagePercent(latest.behind, latest.total, latest.done)}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-label="{latest.name}: {latest.label}"
			>
				<div class="fill ahead" style="width: {stagePercent(latest.ahead, latest.total, latest.done)}%"></div>
				<div class="fill behind" style="width: {stagePercent(latest.behind, latest.total, latest.done)}%"></div>
			</div>
			<span class="name">{latest.name}</span>
			<span class="pct">{latest.label}</span>
		</button>
		{#if open}
			<div class="menu" use:anchoredPopup={{ anchor: () => rootEl?.querySelector('.chip'), onClose: () => (open = false), offset: 4 }} role="menu" data-testid="fe-op-progress-menu">
				{#each rows as row (row.op.id)}
					<div
						class="menu-row"
						class:failed={row.status === 'failed'}
						class:cancelled={row.status === 'cancelled'}
						class:done={row.done}
						data-testid="fe-op-progress-menu-row"
						data-status={row.status}
						data-name={row.name}
						data-copy-hop={row.route}
					>
						<div
							class="bar"
							role="progressbar"
							aria-valuenow={stagePercent(row.behind, row.total, row.done)}
							aria-valuemin={0}
							aria-valuemax={100}
						>
							<div class="fill ahead" style="width: {stagePercent(row.ahead, row.total, row.done)}%"></div>
							<div class="fill behind" style="width: {stagePercent(row.behind, row.total, row.done)}%"></div>
						</div>
						<span class="name" title={row.note ?? row.name}>{row.name}</span>
						<span class="pct">{row.label}</span>
						<button
							type="button"
							class="x"
							onclick={() => void dismissRow(row.op)}
							aria-label={row.status === 'active' ? 'Cancel' : 'Dismiss'}
							title={row.status === 'active' ? 'Cancel' : 'Dismiss'}
						>
							<FeIcon name="x" size={12} />
						</button>
					</div>
					{#if row.note}
						<p class="hop">{row.note}</p>
					{/if}
					{#if row.error && row.status !== 'cancelled'}
						<p class="err">{row.error}</p>
					{/if}
				{/each}
				{#if hasFinished}
					<button type="button" class="clear" data-testid="fe-op-progress-dismiss" onclick={() => void dismissFinished()}>
						Clear finished
					</button>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	.chip-wrap {
		position: relative;
		display: flex;
		align-items: center;
		align-self: flex-start;
		flex: 0 1 18rem;
		min-width: 9rem;
		max-width: 20rem;
	}
	.chip {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		max-width: 100%;
		height: var(--control-h-sm, 1.75rem);
		padding: 0 0.35rem 0 0;
		border: 0;
		border-radius: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 0.72rem;
		cursor: pointer;
	}
	.chip:hover .bar {
		outline: 1px solid var(--line-hairline, #64748b);
	}
	.bar {
		position: relative;
		flex: 1 1 7.5rem;
		min-width: 5.5rem;
		height: 8px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--text-primary, #e2e8f0) 14%, transparent);
		overflow: hidden;
	}
	.fill {
		position: absolute;
		inset: 0 auto 0 0;
		height: 100%;
		border-radius: 999px;
	}
	.fill.ahead {
		background: color-mix(in srgb, var(--accent, #38bdf8) 40%, transparent);
	}
	.fill.behind {
		background: var(--accent, #38bdf8);
	}
	.failed .fill.ahead {
		background: color-mix(in srgb, var(--danger, #f87171) 40%, transparent);
	}
	.failed .fill.behind {
		background: var(--danger, #f87171);
	}
	.cancelled .fill.ahead,
	.cancelled .fill.behind {
		background: color-mix(in srgb, var(--text-muted, #94a3b8) 70%, transparent);
	}
	.cancelled .pct,
	.cancelled .name {
		color: var(--text-muted, #94a3b8);
	}
	.done .fill.ahead,
	.done .fill.behind {
		background: var(--accent-emerald, #34d399);
	}
	.name {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	.pct {
		flex: 0 0 auto;
		font-variant-numeric: tabular-nums;
		opacity: 0.8;
		white-space: nowrap;
	}
	.menu {
		position: absolute;
		z-index: 50;
		top: calc(100% + 4px);
		left: 0;
		min-width: 16rem;
		max-width: min(24rem, 80vw);
		max-height: min(40vh, 280px);
		overflow: auto;
		padding: 0.4rem 0.45rem 0.45rem;
		border: 1px solid var(--line-hairline);
		background: var(--surface-2);
		box-shadow: 0 12px 32px rgb(var(--scrim-rgb) / 0.35);
	}
	.menu-row {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.3rem 0;
	}
	.x,
	.clear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: 0;
		color: inherit;
		cursor: pointer;
		opacity: 0.75;
		padding: 0 0.2rem;
		font: inherit;
		font-size: 0.72rem;
	}
	.clear {
		width: 100%;
		margin-top: 0.25rem;
		padding: 0.3rem 0.25rem;
		border-top: 1px solid var(--line-hairline);
		opacity: 0.85;
	}
	.hop {
		margin: 0 0 0.25rem;
		padding-left: 0.15rem;
		color: var(--text-muted);
		font-size: 0.72rem;
		line-height: 1.3;
	}
	.err {
		margin: 0 0 0.25rem;
		color: var(--cat-red-soft);
		font-size: 0.72rem;
	}
</style>
