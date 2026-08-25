<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import {
		HUB_MONITOR_PROFILES_CHANNEL,
		subscribeTabChannel
	} from '@shared-packages/file-system';
	import {
		acquireMonitorDriver,
		releaseMonitorDriver,
		getActiveProfileId,
		getHostStream,
		listProfiles,
		setActiveProfileId,
		toAbsolutePath,
		baseName,
		type MonitorConnectionProfileV1,
		type MonitorHostSnapshot
	} from '@shared-packages/file-system/monitor';
	import {
		FeTreeView,
		detectProject,
		formatExplorerError,
		type ExplorerDriver,
		type ExplorerEntryId
	} from '@shared-packages/file-system/ui';
	import { createGitHost, GitHistory, type GitRepoRef } from '@shared-packages/git';
	import { diskPct, memPct, pct, type HostSnapshot } from './types.js';
	import { SPARKLINE_N, samplesToPoints } from './sparkline.js';
	import { toast } from '@shared-packages/ui';

	const gitHost = createGitHost();

	let profiles = $state<MonitorConnectionProfileV1[]>([]);
	let profile = $state<MonitorConnectionProfileV1 | null>(null);
	let driver = $state<ExplorerDriver | null>(null);
	let error = $state('');
	let booting = $state(true);
	let selectedId = $state<ExplorerEntryId | null>(null);
	let hostSnap = $state<HostSnapshot | null>(null);
	let samples = $state<Array<{ cpu: number; mem: number; disk: number }>>([]);
	let gitRepo = $state<GitRepoRef | null>(null);

	function asHost(s: MonitorHostSnapshot): HostSnapshot {
		return {
			cpu_pct: s.cpu_pct,
			mem_used: s.mem_used,
			mem_total: s.mem_total,
			disks: s.disks.map((d) => ({ name: d.name, used: d.used, total: d.total }))
		};
	}

	async function applyProfile(p: MonitorConnectionProfileV1) {
		error = '';
		if (profile && profile.id !== p.id) releaseMonitorDriver(profile.id);
		profile = p;
		try {
			driver = await acquireMonitorDriver(p);
			selectedId = null;
			if (p.id !== (await getActiveProfileId())) await setActiveProfileId(p.id);
		} catch (e) {
			error = formatExplorerError(e);
			toast.error(error);
			driver = null;
		}
	}

	async function refreshProfiles(cancelled?: { v: boolean }): Promise<void> {
		const all = await listProfiles();
		if (cancelled?.v) return;
		profiles = all;
		const activeId = await getActiveProfileId();
		if (cancelled?.v) return;
		const pick = (activeId && all.find((p) => p.id === activeId)) || all[0] || null;
		if (!pick) {
			if (profile) releaseMonitorDriver(profile.id);
			profile = null;
			driver = null;
			hostSnap = null;
			samples = [];
			gitRepo = null;
			return;
		}
		if (profile?.id === pick.id && driver) return;
		await applyProfile(pick);
	}

	function onSelectProfile(e: Event) {
		const id = (e.currentTarget as HTMLSelectElement).value;
		const next = profiles.find((p) => p.id === id);
		if (next) void applyProfile(next);
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
		if (!p || !d) return;
		let cancelled = false;
		void (async () => {
			const ok = await detectProject(d, folder);
			if (cancelled || !ok) return;
			const abs = toAbsolutePath(p.rootPath, folder);
			const label = folder ? baseName(folder) : p.rootPath;
			const listed = await gitHost.listRepos();
			if (cancelled) return;
			const existing = listed.find((r) => r.backend === 'monitor' && r.path === abs);
			if (existing) {
				gitRepo = existing;
				return;
			}
			const added = await gitHost.addRepo({
				label,
				backend: 'monitor',
				path: abs,
				profileId: p.id,
				baseUrl: p.baseUrl
			});
			if (cancelled) return;
			gitRepo = added;
		})();
		return () => {
			cancelled = true;
		};
	});

	onMount(() => {
		const cancelled = { v: false };
		void (async () => {
			const deadline = Date.now() + 2000;
			while (!cancelled.v && Date.now() < deadline) {
				try {
					await refreshProfiles(cancelled);
					return;
				} catch {
					await new Promise((r) => setTimeout(r, 100));
				}
			}
		})().finally(() => {
			if (!cancelled.v) booting = false;
		});
		const unsub = subscribeTabChannel(HUB_MONITOR_PROFILES_CHANNEL, () => {
			void refreshProfiles(cancelled);
		});
		return () => {
			cancelled.v = true;
			unsub();
		};
	});
</script>

<div class="monitor-app" data-testid="monitor-tool">
	<div class="toolbar">
		{#if profiles.length}
			<label class="profile-pick">
				<span class="visually-hidden">Monitor connection</span>
				<select
					data-testid="monitor-profile-select"
					value={profile?.id ?? profiles[0]?.id}
					onchange={onSelectProfile}
				>
					{#each profiles as p (p.id)}
						<option value={p.id}>{p.name} · {p.rootPath}</option>
					{/each}
				</select>
			</label>
		{/if}
	</div>
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
			{:else if booting}
				<p class="empty">Loading connection…</p>
			{:else}
				<p class="empty" data-testid="monitor-no-connection">
					Save a monitor connection in Files, then open Monitor again.
				</p>
			{/if}
		</div>
		<div class="git">
			{#if gitRepo}
				<GitHistory {gitHost} repoId={gitRepo.id} />
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
	.toolbar {
		display: flex;
		justify-content: flex-end;
		min-height: 1.75rem;
	}
	.profile-pick select {
		max-width: min(28rem, 100%);
		padding: 0.35rem 0.55rem;
		border: 1px solid var(--line-hairline, #ddd);
		background: transparent;
		color: inherit;
		font: inherit;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
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
