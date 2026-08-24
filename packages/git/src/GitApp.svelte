<script lang="ts">
	import { DEFAULT_MONITOR_BASE_URL } from '@shared-packages/file-system/monitor';
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
	let label = $state('');
	let backend = $state<'local' | 'monitor'>('monitor');
	let path = $state('');
	let baseUrl = $state(DEFAULT_MONITOR_BASE_URL);
	let error = $state('');

	async function reload() {
		repos = await gitHost.listRepos();
		if (selectedId && !repos.some((r) => r.id === selectedId)) selectedId = repos[0]?.id ?? null;
	}

	$effect(() => {
		void gitHost;
		void reload();
	});

	async function maybeInitLocal(repoPath: string) {
		if (typeof gitHost.initLocal !== 'function') return;
		try {
			await gitHost.initLocal(repoPath);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			// Already a git repo / existing .git is success (idempotent).
			if (/already a git repo|already exists|git directory already exists/i.test(msg)) return;
			throw e;
		}
	}

	async function add() {
		error = '';
		if (!label.trim() || !path.trim()) {
			error = 'Label and path are required';
			return;
		}
		try {
			const repo = await gitHost.addRepo({
				label: label.trim(),
				backend,
				path: path.trim(),
				baseUrl: backend === 'monitor' ? baseUrl.trim() || DEFAULT_MONITOR_BASE_URL : undefined
			});
			if (backend === 'local') await maybeInitLocal(repo.path);
			label = '';
			path = '';
			await reload();
			selectedId = repo.id;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function remove(id: string) {
		await gitHost.removeRepo(id);
		if (selectedId === id) selectedId = null;
		await reload();
	}
</script>

<div class="git-app" data-testid="git-app">
	<form
		class="add"
		data-testid="git-repo-form"
		onsubmit={(e) => {
			e.preventDefault();
			void add();
		}}
	>
		<label>
			Label
			<input type="text" bind:value={label} data-testid="git-repo-label" />
		</label>
		<label>
			Backend
			<select bind:value={backend} data-testid="git-repo-backend">
				<option value="local">local</option>
				<option value="monitor">monitor</option>
			</select>
		</label>
		<label>
			Path
			<input
				type="text"
				bind:value={path}
				data-testid="git-repo-path"
				placeholder={backend === 'local' ? 'VFS folder id' : ''}
			/>
		</label>
		{#if backend === 'monitor'}
			<label>
				Base URL
				<input type="text" bind:value={baseUrl} data-testid="git-repo-base-url" />
			</label>
		{/if}
		<button type="submit" data-testid="git-repo-add">Add</button>
	</form>
	{#if error}
		<p class="err" role="alert">{error}</p>
	{/if}
	<div class="body">
		<ul class="list" data-testid="git-repo-list">
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
					<button type="button" class="ghost" onclick={() => void remove(repo.id)}>Remove</button>
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
	.add {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: end;
	}
	.add label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 0.8rem;
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
	.active {
		font-weight: 600;
	}
	.err {
		margin: 0;
		color: var(--danger, #b00);
		font-size: 0.85rem;
	}
	.ghost {
		background: none;
		border: none;
		cursor: pointer;
		color: var(--text-secondary, #666);
	}
</style>
