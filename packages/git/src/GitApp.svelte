<script lang="ts">
	import { onMount } from 'svelte';
	import {
		HUB_MONITOR_PROFILES_CHANNEL,
		subscribeTabChannel
	} from '@shared-packages/file-system';
	import {
		DEFAULT_MONITOR_BASE_URL,
		listProfiles,
		type MonitorConnectionProfileV1
	} from '@shared-packages/file-system/monitor';
	import GitHistory from './GitHistory.svelte';
	import { createGitHost } from './host.js';
	import type { GitHost, GitRepoRef } from './types.js';

	let {
		gitHost = createGitHost()
	}: {
		gitHost?: GitHost;
	} = $props();

	let repos = $state<GitRepoRef[]>([]);
	let selectedId = $state<string | null>(null);
	let error = $state('');

	function sameMonitor(repo: GitRepoRef, profile: MonitorConnectionProfileV1): boolean {
		if (repo.backend !== 'monitor') return false;
		if (repo.profileId && repo.profileId === profile.id) return true;
		return (
			repo.path === profile.rootPath &&
			(repo.baseUrl || DEFAULT_MONITOR_BASE_URL) === profile.baseUrl
		);
	}

	async function reload() {
		error = '';
		const saved = await gitHost.listRepos();
		const profiles = await listProfiles();
		const merged = [...saved];
		for (const p of profiles) {
			if (merged.some((r) => sameMonitor(r, p))) continue;
			merged.push(
				await gitHost.addRepo({
					label: p.name,
					backend: 'monitor',
					path: p.rootPath,
					profileId: p.id,
					baseUrl: p.baseUrl
				})
			);
		}
		repos = merged.sort((a, b) => a.label.localeCompare(b.label));
		if (selectedId && !repos.some((r) => r.id === selectedId)) selectedId = null;
		if (!selectedId) selectedId = repos[0]?.id ?? null;
	}

	onMount(() => {
		void reload().catch((e) => {
			error = e instanceof Error ? e.message : String(e);
		});
		return subscribeTabChannel(HUB_MONITOR_PROFILES_CHANNEL, () => {
			void reload();
		});
	});
</script>

<div class="git-app" data-testid="git-app">
	{#if error}
		<p class="err" role="alert">{error}</p>
	{/if}
	<div class="body">
		<ul class="list" data-testid="git-repo-list">
			{#if !repos.length}
				<li class="empty" data-testid="git-repo-empty">
					Save a monitor connection in Files, or open a git folder there.
				</li>
			{/if}
			{#each repos as repo (repo.id)}
				<li>
					<button
						type="button"
						class:active={selectedId === repo.id}
						data-testid="git-repo-item"
						onclick={() => (selectedId = repo.id)}
					>
						<span>{repo.label}</span>
						<small>{repo.backend} · {repo.path}</small>
					</button>
				</li>
			{/each}
		</ul>
		{#if selectedId}
			<GitHistory {gitHost} repoId={selectedId} />
		{:else}
			<GitHistory snapshot={null} />
		{/if}
	</div>
</div>

<style>
	.git-app {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-height: 0;
		height: 100%;
	}
	.body {
		display: grid;
		grid-template-columns: minmax(12rem, 22%) 1fr;
		gap: 12px;
		min-height: 0;
		flex: 1;
	}
	.list {
		margin: 0;
		padding: 0;
		list-style: none;
		overflow: auto;
		border-right: 1px solid var(--line-hairline, #eee);
	}
	.list li {
		display: flex;
		gap: 4px;
		align-items: start;
	}
	.list button {
		text-align: left;
	}
	.list small {
		display: block;
		color: var(--text-secondary, #666);
	}
	.empty {
		padding: 0.5rem 0.65rem;
		font-size: 0.85rem;
		color: var(--text-secondary, #666);
	}
	.active {
		font-weight: 600;
	}
	.err {
		margin: 0;
		color: var(--danger, #b00);
		font-size: 0.85rem;
	}
</style>
