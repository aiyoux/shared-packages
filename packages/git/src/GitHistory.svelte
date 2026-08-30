<script lang="ts">
	import { untrack } from 'svelte';
	import type { GitAuthor, GitHost, GitSnapshot } from './types.js';

	const AUTHOR_KEY = 'git.author';

	/**
	 * Commit identity. git requires a name and email on every commit, and there
	 * is no account system here to take one from — so it is asked for once and
	 * kept locally. No default is invented: a commit attributed to a made-up
	 * person is worse than being asked.
	 */
	function loadAuthor(): GitAuthor {
		try {
			const raw = localStorage.getItem(AUTHOR_KEY);
			if (raw) {
				const p = JSON.parse(raw) as Partial<GitAuthor>;
				if (p && typeof p.name === 'string' && typeof p.email === 'string') {
					return { name: p.name, email: p.email };
				}
			}
		} catch {
			/* private mode, or corrupt value */
		}
		return { name: '', email: '' };
	}

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
	let loadError = $state('');
	const shown = $derived(snapshot ?? live);

	let author = $state<GitAuthor>(loadAuthor());
	let message = $state('');
	let committing = $state(false);
	let commitError = $state('');
	/** Paths explicitly UNticked. Everything changed is included by default. */
	let excluded = $state(new Set<string>());

	const changes = $derived(shown?.changes ?? []);
	const selected = $derived(changes.filter((c) => !excluded.has(c.path)).map((c) => c.path));
	const canCommit = $derived(
		Boolean(gitHost && repoId) &&
			selected.length > 0 &&
			message.trim().length > 0 &&
			author.name.trim().length > 0 &&
			author.email.trim().length > 0 &&
			!committing
	);

	function toggle(path: string) {
		const next = new Set(excluded);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		excluded = next;
	}

	async function doCommit() {
		if (!gitHost || !repoId || !canCommit) return;
		committing = true;
		commitError = '';
		try {
			try {
				localStorage.setItem(AUTHOR_KEY, JSON.stringify(author));
			} catch {
				/* not fatal — the commit still carries the identity */
			}
			await gitHost.commit(repoId, {
				message: message.trim(),
				paths: selected,
				author: { name: author.name.trim(), email: author.email.trim() }
			});
			message = '';
			excluded = new Set();
			// The subscription repaints the log; nothing to do here.
		} catch (e) {
			commitError = e instanceof Error ? e.message : 'Commit failed';
		} finally {
			committing = false;
		}
	}

	$effect(() => {
		const host = gitHost;
		const id = repoId;
		if (!host || !id) return;
		untrack(() => {
			live = null;
			loadError = '';
		});
		void host
			.snapshot(id)
			.then((s) => {
				live = s;
				loadError = '';
			})
			.catch((e) => {
				// Keep `live` null: a failed read is an error to show, never an
				// empty log that reads as "this repo has no commits".
				loadError = e instanceof Error ? e.message : 'Could not read git history';
			});
		return host.subscribe(id, (s) => {
			live = s;
			loadError = '';
		});
	});

	function shortSha(sha: string): string {
		return sha.slice(0, 7);
	}
</script>

<section class="git-history" data-testid="git-history">
	{#if loadError}
		<p class="error" data-testid="git-history-error">{loadError}</p>
	{:else if shown}
		<p class="status">
			<span data-testid="git-history-branch">{shown.status.branch ?? '(detached)'}</span>
			{#if shown.status.dirty}
				<span class="dirty" data-testid="git-history-dirty">dirty</span>
			{/if}
		</p>
		{#if gitHost && repoId && changes.length > 0}
			<div class="commit" data-testid="git-commit-panel">
				<ul class="changes" data-testid="git-changes">
					{#each changes as c (c.path)}
						<li>
							<label>
								<input
									type="checkbox"
									checked={!excluded.has(c.path)}
									data-testid="git-change-{c.path}"
									onchange={() => toggle(c.path)}
								/>
								<span class="st st-{c.status}">{c.status[0]!.toUpperCase()}</span>
								<span class="path">{c.path}</span>
							</label>
						</li>
					{/each}
				</ul>
				<input
					class="msg"
					type="text"
					placeholder="Commit message"
					bind:value={message}
					disabled={committing}
					data-testid="git-commit-message"
				/>
				{#if !author.name.trim() || !author.email.trim()}
					<div class="who">
						<input
							type="text"
							placeholder="Your name"
							bind:value={author.name}
							data-testid="git-author-name"
						/>
						<input
							type="email"
							placeholder="you@example.com"
							bind:value={author.email}
							data-testid="git-author-email"
						/>
					</div>
				{/if}
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--primary"
					disabled={!canCommit}
					data-testid="git-commit-btn"
					onclick={() => void doCommit()}
				>
					{committing ? 'Committing…' : `Commit ${selected.length} file${selected.length === 1 ? '' : 's'}`}
				</button>
				{#if commitError}
					<p class="error" data-testid="git-commit-error">{commitError}</p>
				{/if}
			</div>
		{/if}
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
	{:else if repoId}
		<p class="empty" data-testid="git-history-empty">Loading…</p>
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
	.commit {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 8px;
		border: 1px solid var(--line-hairline, #ccc);
		border-radius: var(--radius-sm, 4px);
	}
	.changes {
		list-style: none;
		margin: 0;
		padding: 0;
		max-height: 30vh;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.changes label {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.8rem;
		min-width: 0;
	}
	.changes .path {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.st {
		font-family: var(--font-mono, monospace);
		font-size: 0.7rem;
		width: 1em;
		text-align: center;
		color: var(--text-secondary, #666);
	}
	.st-added {
		color: var(--ok, #2a7);
	}
	.st-deleted {
		color: var(--danger, #c33);
	}
	.msg,
	.who input {
		padding: 4px 6px;
		border: 1px solid var(--line-hairline, #ccc);
		border-radius: var(--radius-sm, 4px);
		background: var(--surface-1, transparent);
		color: var(--text-primary, inherit);
		font-size: 0.8rem;
		min-width: 0;
	}
	.who {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px;
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
	.error {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-danger, #b3261e);
	}
</style>
