<script lang="ts">
	import { untrack } from 'svelte';
	import {
		FeTreeView,
		type ExplorerDriver,
		type ExplorerEntryId
	} from '@shared-packages/file-system/ui';
	import { createGitHost } from './host.js';
	import GitHistory from './GitHistory.svelte';
	import { consumeOpenProject, type OpenProjectPayload } from './openProject.js';
	import {
		bindProjectRepo,
		resolveProjectRoot,
		type ProjectBackendHint
	} from './projectRepo.js';
	import type { GitHost, GitRepoRef } from './types.js';

	let {
		driver = undefined,
		folderId = null,
		gitHost = createGitHost(),
		repo = undefined,
		/** When passed (including `null`), skip sessionStorage consume — the parent already did. */
		opened = undefined,
		connection = undefined,
		connectionLabel = 'Files'
	}: {
		driver?: ExplorerDriver;
		folderId?: ExplorerEntryId | null;
		gitHost?: GitHost;
		/** `null` closes the open project. */
		repo?: GitRepoRef | null;
		opened?: OpenProjectPayload | null;
		/** Backend `driver` talks to, so browsing without a handoff still binds
		 *  monitor paths correctly. */
		connection?: ProjectBackendHint;
		/** Tree root label while no project is open. */
		connectionLabel?: string;
	} = $props();

	// Fallback for parents that do not own the handoff. Consumed once, at init.
	const consumed = opened === undefined ? consumeOpenProject() : null;
	const payload = $derived(opened ?? consumed);

	let activeRepo = $state<GitRepoRef | null>(null);
	/**
	 * Explorer id of the working tree — the tree is rooted here, so Projects
	 * shows the project rather than everything on the connection.
	 */
	let projectRootId = $state<ExplorerEntryId | null>(null);
	let projectLabel = $state('');
	let selectedId = $state<ExplorerEntryId | null>(null);
	/** Newest resolve wins; late replies from a previous folder are dropped. */
	let resolveReq = 0;

	const rootLabel = $derived(projectLabel || connectionLabel);

	$effect(() => {
		const incoming = repo;
		if (incoming === undefined) return;
		if (incoming === null) {
			// Drop any resolve still in flight so it cannot reopen what was closed.
			resolveReq++;
			activeRepo = null;
			projectRootId = null;
			selectedId = null;
			projectLabel = '';
			return;
		}
		activeRepo = incoming;
		projectLabel = incoming.label;
	});

	function labelFor(p: OpenProjectPayload): string {
		return p.label || p.path.split('/').filter(Boolean).pop() || 'Project';
	}

	/**
	 * Bind the working tree at `id` (or the handoff payload's, when the driver
	 * cannot see it) and root the tree there.
	 */
	async function openProject(
		d: ExplorerDriver | undefined,
		id: ExplorerEntryId | null,
		p: OpenProjectPayload | null
	): Promise<void> {
		const req = ++resolveReq;
		const current = untrack(() => activeRepo);
		const conn = untrack(() => connection);
		const hint: ProjectBackendHint = {
			backend: p?.backend ?? conn?.backend ?? current?.backend ?? 'local',
			rootPath: p?.rootPath ?? conn?.rootPath ?? current?.rootPath,
			profileId: p?.profileId ?? conn?.profileId ?? current?.profileId,
			baseUrl: p?.baseUrl ?? conn?.baseUrl ?? current?.baseUrl
		};

		if (d && id != null) {
			const hit = await resolveProjectRoot(d, id, hint);
			if (req !== resolveReq) return;
			if (hit) {
				const bound = await bindProjectRepo(gitHost, hit.input);
				if (req !== resolveReq) return;
				// Clicking inside the open project keeps the caller's selection;
				// only a different working tree re-roots the tree.
				if (untrack(() => projectRootId) !== hit.folderId || untrack(() => activeRepo)?.id !== bound.id) {
					projectRootId = hit.folderId;
					selectedId = hit.folderId;
				}
				activeRepo = bound;
				projectLabel = hit.input.label;
				return;
			}
			// Not a project (and no handoff to fall back on): keep what is open.
			if (!p) return;
		}

		if (!p) return;
		const bound = await bindProjectRepo(gitHost, {
			label: labelFor(p),
			backend: p.backend,
			path: p.path,
			...(p.profileId ? { profileId: p.profileId } : {}),
			...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
			...(p.rootPath ? { rootPath: p.rootPath } : {})
		});
		if (req !== resolveReq) return;
		activeRepo = bound;
		projectRootId = p.folderId ?? null;
		selectedId = p.folderId ?? null;
		projectLabel = labelFor(p);
	}

	$effect(() => {
		const d = driver;
		const id = folderId ?? null;
		const p = payload;
		if (!d && !p) return;
		untrack(() => {
			void openProject(d, id, p);
		});
	});

	async function initLocalRepo() {
		const repoPath = activeRepo?.backend === 'local' ? activeRepo.path : null;
		if (!repoPath || typeof gitHost.initLocal !== 'function') return;
		try {
			await gitHost.initLocal(repoPath);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (/already a git repo|already exists|git directory already exists/i.test(msg)) return;
			throw e;
		}
	}
</script>

<div class="projects" data-testid="projects-tool">
	<div class="tree">
		{#if driver}
			<FeTreeView
				{driver}
				activeId={selectedId}
				includeFiles={true}
				rootId={projectRootId}
				{rootLabel}
				onNavigate={(id) => {
					selectedId = id;
					void openProject(driver, id, null);
				}}
			/>
		{:else}
			<p class="empty">No folder open</p>
		{/if}
	</div>
	<div class="hist">
		{#if activeRepo?.backend === 'local'}
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
