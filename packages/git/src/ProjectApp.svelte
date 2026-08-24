<script lang="ts">
	import { untrack } from 'svelte';
	import { FeTreeView, type ExplorerDriver, type ExplorerEntryId } from '@shared-packages/file-system/ui';
	import { createGitHost } from './host.js';
	import GitHistory from './GitHistory.svelte';
	import { consumeOpenProject, type OpenProjectPayload } from './openProject.js';
	import type { GitHost, GitRepoRef } from './types.js';

	let {
		driver = undefined,
		folderId = null,
		gitHost = createGitHost(),
		repo = undefined,
		/** When passed (including `null`), skip sessionStorage consume — the parent already did. */
		opened = undefined
	}: {
		driver?: ExplorerDriver;
		folderId?: ExplorerEntryId | null;
		gitHost?: GitHost;
		repo?: GitRepoRef;
		opened?: OpenProjectPayload | null;
	} = $props();

	let activeRepo = $state<GitRepoRef | null>(null);
	let rootLabel = $state('Project');
	let selectedId = $state<ExplorerEntryId | null>(null);

	$effect(() => {
		selectedId = folderId ?? null;
	});

	$effect(() => {
		const incoming = repo;
		if (incoming) activeRepo = incoming;
	});

	$effect(() => {
		const fromProp = opened;
		const payload = fromProp === undefined ? consumeOpenProject() : fromProp;
		if (!payload) return;
		const host = untrack(() => gitHost);
		void (async () => {
			const added = await host.addRepo({
				label: payload.label || payload.path.split('/').filter(Boolean).pop() || 'Project',
				backend: payload.backend,
				path: payload.path,
				profileId: payload.profileId,
				baseUrl: payload.baseUrl
			});
			activeRepo = added;
		})();
	});

	async function initLocalRepo() {
		const repoPath =
			activeRepo?.backend === 'local'
				? activeRepo.path
				: opened?.backend === 'local'
					? opened.path
					: null;
		if (!repoPath || typeof gitHost.initLocal !== 'function') return;
		try {
			await gitHost.initLocal(repoPath);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (/already a git repo|already exists|git directory already exists/i.test(msg)) return;
			throw e;
		}
	}

	$effect(() => {
		const d = driver;
		const id = folderId ?? null;
		if (!d || id == null) {
			const fromPath = activeRepo?.path.split('/').filter(Boolean).pop();
			if (fromPath) rootLabel = fromPath;
			return;
		}
		void d.getPath(id).then((chain) => {
			const last = chain[chain.length - 1];
			if (last?.name) rootLabel = last.name;
		});
	});
</script>

<div class="projects" data-testid="projects-tool">
	<div class="tree">
		{#if driver}
			<FeTreeView
				{driver}
				activeId={selectedId}
				includeFiles={true}
				{rootLabel}
				onNavigate={(id) => {
					selectedId = id;
				}}
			/>
		{:else}
			<p class="empty">No folder open</p>
		{/if}
	</div>
	<div class="hist">
		{#if activeRepo?.backend === 'local' || opened?.backend === 'local'}
			<button type="button" data-testid="projects-init-repo" onclick={() => void initLocalRepo()}>
				Init
			</button>
		{/if}
		{#if activeRepo}
			<GitHistory {gitHost} repoId={activeRepo.id} />
		{:else}
			<GitHistory snapshot={null} />
		{/if}
	</div>
</div>

<style>
	.projects {
		display: grid;
		grid-template-columns: minmax(12rem, 32%) 1fr;
		gap: 12px;
		min-height: 0;
		height: 100%;
	}
	.tree,
	.hist {
		min-width: 0;
		min-height: 0;
		overflow: auto;
	}
	.empty {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-secondary, #666);
	}
</style>
