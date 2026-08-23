<script lang="ts">
	import { untrack } from 'svelte';
	import {
		MonitorConnectionForm,
		acquireMonitorDriver,
		releaseMonitorDriver,
		getHostStream,
		getGitStream,
		toAbsolutePath,
		baseName,
		type MonitorConnectionProfileV1,
		type MonitorHostSnapshot
	} from '@shared-packages/file-system/monitor';
	import {
		FeTreeView,
		detectProject,
		type ExplorerDriver,
		type ExplorerEntryId
	} from '@shared-packages/file-system/ui';
	import { GitHistory, mapMonitorGitSnapshot, type GitRepoRef, type GitSnapshot } from '@shared-packages/git';
	import { diskPct, memPct, pct, type HostSnapshot } from './types.js';
	import { SPARKLINE_N, samplesToPoints } from './sparkline.js';

	let profile = $state<MonitorConnectionProfileV1 | null>(null);
	let driver = $state<ExplorerDriver | null>(null);
	let error = $state('');
	let selectedId = $state<ExplorerEntryId | null>(null);
	let hostSnap = $state<HostSnapshot | null>(null);
	let samples = $state<Array<{ cpu: number; mem: number; disk: number }>>([]);
	let gitRepo = $state<GitRepoRef | null>(null);
	let gitSnap = $state<GitSnapshot | null>(null);

	function asHost(s: MonitorHostSnapshot): HostSnapshot {
		return {
			cpu_pct: s.cpu_pct,
			mem_used: s.mem_used,
			mem_total: s.mem_total,
			disks: s.disks.map((d) => ({ name: d.name, used: d.used, total: d.total }))
		};
	}

	async function onConnected(p: MonitorConnectionProfileV1) {
		error = '';
		if (profile) releaseMonitorDriver(profile.id);
		profile = p;
		try {
			driver = await acquireMonitorDriver(p);
			selectedId = null;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			driver = null;
		}
	}

	function onDisconnected() {
		if (profile) releaseMonitorDriver(profile.id);
		profile = null;
		driver = null;
		hostSnap = null;
		samples = [];
		gitRepo = null;
		gitSnap = null;
	}

	$effect(() => {
		const p = profile;
		samples = [];
		hostSnap = null;
		if (!p) return;
		return getHostStream(p).subscribe((s) => {
			const snap = asHost(s);
			hostSnap = snap;
			const prev = untrack(() => samples);
			samples = [...prev, { cpu: snap.cpu_pct, mem: memPct(snap), disk: diskPct(snap) }].slice(
				-SPARKLINE_N
			);
		});
	});

	$effect(() => {
		const p = profile;
		const d = driver;
		const folder = selectedId;
		gitRepo = null;
		gitSnap = null;
		if (!p || !d) return;
		let unsub = () => {};
		let cancelled = false;
		void (async () => {
			const ok = await detectProject(d, folder);
			if (cancelled || !ok) return;
			const abs = toAbsolutePath(p.rootPath, folder);
			const label = folder ? baseName(folder) : p.rootPath;
			gitRepo = {
				id: `monitor:${p.id}:${abs}`,
				label,
				backend: 'monitor',
				path: abs,
				profileId: p.id,
				baseUrl: p.baseUrl
			};
			unsub = getGitStream(p, abs).subscribe((s) => {
				gitSnap = mapMonitorGitSnapshot(s);
			});
		})();
		return () => {
			cancelled = true;
			unsub();
		};
	});
</script>

<div class="monitor-app" data-testid="monitor-tool">
	<MonitorConnectionForm {onConnected} {onDisconnected} />
	{#if error}
		<p class="err" role="alert">{error}</p>
	{/if}
	{#if hostSnap}
		<div class="metrics">
			<div class="metric" data-testid="monitor-cpu">
				<span>CPU {pct(hostSnap.cpu_pct)}</span>
				<svg viewBox="0 0 100 24" data-testid="monitor-sparkline-cpu" aria-hidden="true">
					<polyline fill="none" stroke="currentColor" stroke-width="1.5" points={samplesToPoints(samples.map((s) => s.cpu))} />
				</svg>
			</div>
			<div class="metric" data-testid="monitor-mem">
				<span>Mem {pct(memPct(hostSnap))}</span>
				<svg viewBox="0 0 100 24" data-testid="monitor-sparkline-mem" aria-hidden="true">
					<polyline fill="none" stroke="currentColor" stroke-width="1.5" points={samplesToPoints(samples.map((s) => s.mem))} />
				</svg>
			</div>
			<div class="metric" data-testid="monitor-disk">
				<span>Disk {pct(diskPct(hostSnap))}</span>
				<svg viewBox="0 0 100 24" data-testid="monitor-sparkline-disk" aria-hidden="true">
					<polyline fill="none" stroke="currentColor" stroke-width="1.5" points={samplesToPoints(samples.map((s) => s.disk))} />
				</svg>
			</div>
		</div>
	{/if}
	<div class="body">
		<div class="tree">
			{#if driver}
				<FeTreeView
					{driver}
					activeId={selectedId}
					onNavigate={(id) => {
						selectedId = id;
					}}
				/>
			{:else}
				<p class="empty">Connect a monitor to browse</p>
			{/if}
		</div>
		<div class="git">
			{#if gitRepo}
				<GitHistory snapshot={gitSnap} />
			{:else}
				<GitHistory snapshot={null} />
			{/if}
		</div>
	</div>
</div>

<style>
	.monitor-app {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-height: 0;
		height: 100%;
	}
	.metrics {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
	}
	.metric {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px;
		border: 1px solid var(--line-hairline, #ddd);
		font-size: 0.85rem;
	}
	.metric svg {
		width: 100%;
		height: 24px;
	}
	.body {
		display: grid;
		grid-template-columns: minmax(12rem, 36%) 1fr;
		gap: 12px;
		min-height: 0;
		flex: 1;
	}
	.tree,
	.git {
		min-width: 0;
		min-height: 0;
		overflow: auto;
	}
	.empty,
	.err {
		margin: 0;
		font-size: 0.85rem;
	}
	.err {
		color: var(--danger, #b00);
	}
</style>
