<script lang="ts">
	import { untrack } from 'svelte';
	import type { GitHost, GitSnapshot } from './types.js';

	let {
		snapshot = null,
		gitHost = undefined,
		repoId = undefined
	}: {
		snapshot?: GitSnapshot | null;
		gitHost?: GitHost;
		repoId?: string;
	} = $props();

	let live = $state<GitSnapshot | null>(null);
	const shown = $derived(snapshot ?? live);

	$effect(() => {
		const host = gitHost;
		const id = repoId;
		if (!host || !id) return;
		untrack(() => {
			live = null;
		});
		void host.snapshot(id).then((s) => {
			live = s;
		}).catch(() => {
			live = { status: { branch: null, dirty: false }, log: [] };
		});
		return host.subscribe(id, (s) => {
			live = s;
		});
	});

	function shortSha(sha: string): string {
		return sha.slice(0, 7);
	}
</script>

<section class="git-history" data-testid="git-history">
	{#if shown}
		<p class="status">
			<span data-testid="git-history-branch">{shown.status.branch ?? '(detached)'}</span>
			{#if shown.status.dirty}
				<span class="dirty" data-testid="git-history-dirty">dirty</span>
			{/if}
		</p>
		{#if shown.log.length === 0}
			<p class="empty" data-testid="git-history-empty">No commits</p>
		{:else}
			<ol class="log" data-testid="git-history-log">
				{#each shown.log as c (c.sha + c.subject)}
					<li data-testid="git-history-commit">
						<code>{shortSha(c.sha)}</code>
						<span>{c.subject}</span>
					</li>
				{/each}
			</ol>
		{/if}
	{:else}
		<p class="empty" data-testid="git-history-empty">No repository selected</p>
	{/if}
</section>

<style>
	.git-history {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-height: 0;
		min-width: 0;
	}
	.status {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0;
		font-size: 0.85rem;
	}
	.dirty {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 1px 6px;
		border: 1px solid var(--line-hairline, #ccc);
		color: var(--text-secondary, #666);
	}
	.log {
		margin: 0;
		padding: 0;
		list-style: none;
		overflow: auto;
	}
	.log li {
		display: flex;
		gap: 8px;
		padding: 4px 0;
		font-size: 0.85rem;
		border-bottom: 1px solid var(--line-hairline, #eee);
	}
	.log code {
		font-variant-ligatures: none;
		flex: 0 0 auto;
	}
	.empty {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-secondary, #666);
	}
</style>
