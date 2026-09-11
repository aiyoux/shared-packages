<script lang="ts">
	import { untrack } from 'svelte';
	import type { GitAuthor, GitFileDiff, GitHost, GitSnapshot } from './types.js';
	import { applySelection, type DiffHunk } from './diffLines.js';
	import DiffView from './DiffView.svelte';

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
		repoId = undefined,
		onInit = undefined,
		initBusy = false
	}: {
		snapshot?: GitSnapshot | null;
		gitHost?: GitHost;
		repoId?: string;
		onInit?: () => void | Promise<void>;
		initBusy?: boolean;
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

	/** The one path currently expanded to its diff, if any. */
	let expandedPath = $state<string | null>(null);
	type DiffFetch =
		| { status: 'loading' }
		| { status: 'error'; error: string }
		| { status: 'ready'; result: GitFileDiff };
	/** Diff fetch state per path, cached for as long as the row stays
	 *  mounted — re-expanding doesn't re-fetch. */
	let diffs = $state(new Map<string, DiffFetch>());
	/** Per-path opIndex values left OUT of the commit — only present for a
	 *  path whose diff was hand-edited (GitHub-Desktop-style hunk/line
	 *  selection). A path absent here commits the whole working file, same
	 *  as before this existed. */
	let lineExclusions = $state(new Map<string, Set<number>>());
	const EMPTY_EXCLUDED: ReadonlySet<number> = new Set();

	const changes = $derived(shown?.changes ?? []);
	/** A `renamed` row stages as two ordinary paths: remove `renamedFrom`, add
	 *  `path` — that IS a git rename (git detects it from content similarity
	 *  at log time, never stores it explicitly), so `localCommit` needs no
	 *  rename-specific handling at all. */
	const selected = $derived(
		changes
			.filter((c) => !excluded.has(c.path))
			.flatMap((c) => (c.status === 'renamed' && c.renamedFrom ? [c.renamedFrom, c.path] : [c.path]))
	);
	/** File count for the commit button label — `selected` is the flat path
	 *  list `localCommit` stages (a rename is two paths there), not what a
	 *  human would call "how many files". */
	const selectedFileCount = $derived(changes.filter((c) => !excluded.has(c.path)).length);
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

	function toggleExpand(path: string) {
		if (expandedPath === path) {
			expandedPath = null;
			return;
		}
		expandedPath = path;
		if (diffs.has(path) || !gitHost || !repoId) return;
		const host = gitHost;
		const id = repoId;
		diffs = new Map(diffs).set(path, { status: 'loading' });
		void host.diffFile(id, path).then(
			(result) => {
				diffs = new Map(diffs).set(path, { status: 'ready', result });
			},
			(e) => {
				diffs = new Map(diffs).set(path, {
					status: 'error',
					error: e instanceof Error ? e.message : 'Could not load diff'
				});
			}
		);
	}

	function setExcludedLines(path: string, next: Set<number>) {
		const nextMap = new Map(lineExclusions);
		if (next.size === 0) nextMap.delete(path);
		else nextMap.set(path, next);
		lineExclusions = nextMap;
	}

	function toggleLine(path: string, opIndex: number) {
		const next = new Set(lineExclusions.get(path) ?? []);
		if (next.has(opIndex)) next.delete(opIndex);
		else next.add(opIndex);
		setExcludedLines(path, next);
	}

	function toggleHunk(path: string, hunk: DiffHunk) {
		const changeable = hunk.lines.filter((l) => l.kind !== 'ctx').map((l) => l.opIndex);
		if (!changeable.length) return;
		const next = new Set(lineExclusions.get(path) ?? []);
		const allExcluded = changeable.every((idx) => next.has(idx));
		for (const idx of changeable) {
			if (allExcluded) next.delete(idx);
			else next.add(idx);
		}
		setExcludedLines(path, next);
	}

	/** Bytes to stage for each path with a hand-edited selection — built from
	 *  the SAME oldText/newText the visible diff came from, so `opIndex`
	 *  still lines up. Paths with no customization are left out entirely:
	 *  `gitHost.commit` stages their whole working file, as before. */
	function buildPartialOverrides(): Record<string, Uint8Array> {
		const partial: Record<string, Uint8Array> = {};
		for (const [path, excludedSet] of lineExclusions) {
			if (!excludedSet.size || excluded.has(path)) continue;
			const entry = diffs.get(path);
			if (!entry || entry.status !== 'ready') continue;
			const content = applySelection(entry.result.oldText, entry.result.newText, excludedSet);
			partial[path] = new TextEncoder().encode(content);
		}
		return partial;
	}

	/** Paths currently mid-discard — disables their button so a slow write
	 *  can't be double-clicked into two overlapping writes. */
	let discarding = $state(new Set<string>());

	/** After a discard, the cached diff for this path (if any) no longer
	 *  describes the file. The live subscription will refresh it too, but
	 *  clearing it here immediately avoids a stale flash before that tick. */
	function invalidateDiff(path: string) {
		if (diffs.has(path)) {
			const next = new Map(diffs);
			next.delete(path);
			diffs = next;
		}
		setExcludedLines(path, new Set());
	}

	/** Discard EVERY uncommitted change to `path`: restore HEAD, or remove
	 *  the file if it was never committed. Irreversible — confirmed first. */
	async function discardAll(path: string) {
		if (!gitHost || !repoId || discarding.has(path)) return;
		if (!confirm(`Discard all changes to ${path}?\n\nThis cannot be undone.`)) return;
		discarding = new Set(discarding).add(path);
		try {
			await gitHost.discardAllFile(repoId, path);
			invalidateDiff(path);
			if (expandedPath === path) expandedPath = null;
		} catch (e) {
			commitError = e instanceof Error ? e.message : 'Could not discard changes';
		} finally {
			const next = new Set(discarding);
			next.delete(path);
			discarding = next;
		}
	}

	/** Undo a folded rename: restore `renamedFrom` on disk and remove `path`.
	 *  Irreversible — confirmed first. */
	async function discardRenameRow(path: string, renamedFrom: string) {
		if (!gitHost || !repoId || discarding.has(path)) return;
		if (
			!confirm(
				`Undo the rename of ${renamedFrom} to ${path}?\n\nThis restores ${renamedFrom} and removes ${path}. This cannot be undone.`
			)
		) {
			return;
		}
		discarding = new Set(discarding).add(path);
		try {
			await gitHost.discardRename(repoId, path, renamedFrom);
			invalidateDiff(path);
			if (expandedPath === path) expandedPath = null;
		} catch (e) {
			commitError = e instanceof Error ? e.message : 'Could not discard changes';
		} finally {
			const next = new Set(discarding);
			next.delete(path);
			discarding = next;
		}
	}

	/** Select (stage) every line in a customized file — clears its
	 *  hand-edited selection so the whole working file is staged again. */
	function selectAllLines(path: string) {
		setExcludedLines(path, new Set());
	}

	/** Deselect every changed line in a file — nothing from it is staged
	 *  until individual lines/hunks are picked back. */
	function deselectAllLines(path: string) {
		const entry = diffs.get(path);
		if (!entry || entry.status !== 'ready' || entry.result.diff.kind !== 'text') return;
		const all = new Set<number>();
		for (const hunk of entry.result.diff.hunks) {
			for (const line of hunk.lines) if (line.kind !== 'ctx') all.add(line.opIndex);
		}
		setExcludedLines(path, all);
	}

	/** Discard just one hunk's lines, leaving the rest of the file's
	 *  uncommitted edit alone. Irreversible — confirmed first. */
	async function discardHunk(path: string, hunk: DiffHunk) {
		if (!gitHost || !repoId || discarding.has(path)) return;
		const entry = diffs.get(path);
		if (!entry || entry.status !== 'ready') return;
		const changeable = hunk.lines.filter((l) => l.kind !== 'ctx').map((l) => l.opIndex);
		if (!changeable.length) return;
		if (!confirm(`Discard this hunk in ${path}?\n\nThis cannot be undone.`)) return;
		discarding = new Set(discarding).add(path);
		try {
			const kept = applySelection(entry.result.oldText, entry.result.newText, new Set(changeable));
			await gitHost.discardFile(repoId, path, new TextEncoder().encode(kept));
			invalidateDiff(path);
		} catch (e) {
			commitError = e instanceof Error ? e.message : 'Could not discard changes';
		} finally {
			const next = new Set(discarding);
			next.delete(path);
			discarding = next;
		}
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
			const partial = buildPartialOverrides();
			await gitHost.commit(repoId, {
				message: message.trim(),
				paths: selected,
				author: { name: author.name.trim(), email: author.email.trim() },
				...(Object.keys(partial).length ? { partial } : {})
			});
			message = '';
			excluded = new Set();
			lineExclusions = new Map();
			diffs = new Map();
			expandedPath = null;
			// The subscription repaints the log; nothing to do here.
		} catch (e) {
			commitError = e instanceof Error ? e.message : 'Commit failed';
		} finally {
			committing = false;
		}
	}

	/**
	 * Re-check every diff the user currently has cached (open now, or opened
	 * earlier in this session) against the live file. A path whose text still
	 * matches is left alone — selections stay put. A path that changed gets
	 * its cache replaced and its line selection cleared: the old `opIndex`es
	 * described positions in text that no longer exists, so keeping them
	 * would silently apply the user's picks to the wrong lines.
	 */
	function refreshOpenDiffs(host: GitHost, id: string) {
		for (const [path, entry] of diffs) {
			if (entry.status !== 'ready') continue;
			void host.diffFile(id, path).then(
				(result) => {
					const prev = diffs.get(path);
					if (!prev || prev.status !== 'ready') return; // reset since (e.g. a commit)
					if (prev.result.oldText === result.oldText && prev.result.newText === result.newText) {
						return; // unchanged — opIndexes (and any selection) are still valid
					}
					diffs = new Map(diffs).set(path, { status: 'ready', result });
					setExcludedLines(path, new Set());
				},
				() => {
					/* transient read error — keep showing the last good diff */
				}
			);
		}
	}

	$effect(() => {
		const host = gitHost;
		const id = repoId;
		if (!host || !id) return;
		untrack(() => {
			live = null;
			loadError = '';
			// A different repoId is a different working tree — nothing cached
			// under the old one (diffs, line picks, the expanded row) applies.
			expandedPath = null;
			diffs = new Map();
			lineExclusions = new Map();
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
		return host.subscribe(
			id,
			(s) => {
				live = s;
				loadError = '';
				// Deferred: a host may call back synchronously (real ones never
				// do, but a test double can), and reading `diffs` here — this
				// effect also resets `diffs` on entry — would make the effect
				// depend on the very state it writes, looping forever.
				queueMicrotask(() => refreshOpenDiffs(host, id));
			},
			(e) => {
				loadError = e instanceof Error ? e.message : 'Could not read git history';
			}
		);
	});

	function shortSha(sha: string): string {
		return sha.slice(0, 7);
	}
</script>

<section class="git-history" data-testid="git-history">
	{#if loadError}
		<p class="error" data-testid="git-history-error">{loadError}</p>
	{/if}
	{#if shown}
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
						{@const linesExcluded = lineExclusions.get(c.path)?.size ?? 0}
						{@const entry = diffs.get(c.path)}
						<li>
							<div class="change-row">
								<input
									type="checkbox"
									checked={!excluded.has(c.path)}
									aria-label="Include {c.path}"
									data-testid="git-change-{c.path}"
									onchange={() => toggle(c.path)}
								/>
								<span class="st st-{c.status}">{c.status[0]!.toUpperCase()}</span>
								{#if c.status === 'renamed'}
									<!-- A folded rename has no content diff to expand (see
									     detectRenames — only an exact byte match is paired), so
									     there's no expand affordance here; Discard undoes the
									     rename itself (restores renamedFrom, removes path). -->
									<span class="path rename-path" data-testid="git-change-rename-{c.path}">
										{c.renamedFrom} → {c.path}
									</span>
									<button
										type="button"
										class="discard-btn"
										disabled={discarding.has(c.path)}
										title="Undo this rename"
										data-testid="git-change-discard-{c.path}"
										onclick={() => void discardRenameRow(c.path, c.renamedFrom!)}
									>
										{discarding.has(c.path) ? '…' : 'Discard'}
									</button>
								{:else}
									<button
										type="button"
										class="path-btn"
										aria-expanded={expandedPath === c.path}
										data-testid="git-change-expand-{c.path}"
										onclick={() => toggleExpand(c.path)}
									>
										<span class="chevron" class:open={expandedPath === c.path} aria-hidden="true">▸</span>
										<span class="path">{c.path}</span>
									</button>
									{#if linesExcluded}
										<span
											class="partial-badge"
											title="{linesExcluded} line{linesExcluded === 1 ? '' : 's'} left out of this commit"
											data-testid="git-change-partial-{c.path}"
										>
											±{linesExcluded}
										</span>
									{/if}
									<button
										type="button"
										class="discard-btn"
										disabled={discarding.has(c.path)}
										title="Discard all changes to {c.path}"
										data-testid="git-change-discard-{c.path}"
										onclick={() => void discardAll(c.path)}
									>
										{discarding.has(c.path) ? '…' : 'Discard'}
									</button>
								{/if}
							</div>
							{#if expandedPath === c.path}
								<div class="diff-slot">
									{#if !entry || entry.status === 'loading'}
										<p class="diff-note">Loading diff…</p>
									{:else if entry.status === 'error'}
										<p class="error">{entry.error}</p>
									{:else}
										{#if entry.result.diff.kind === 'text' && entry.result.diff.hunks.length > 1}
											<div class="diff-bulk">
												<button
													type="button"
													class="link-btn"
													disabled={linesExcluded === 0}
													data-testid="git-change-select-all-{c.path}"
													onclick={() => selectAllLines(c.path)}
												>
													Select all
												</button>
												<button
													type="button"
													class="link-btn"
													data-testid="git-change-deselect-all-{c.path}"
													onclick={() => deselectAllLines(c.path)}
												>
													Deselect all
												</button>
											</div>
										{/if}
										<DiffView
											diff={entry.result.diff}
											excluded={lineExclusions.get(c.path) ?? EMPTY_EXCLUDED}
											discardBusy={discarding.has(c.path)}
											onToggleLine={(idx) => toggleLine(c.path, idx)}
											onToggleHunk={(hunk) => toggleHunk(c.path, hunk)}
											onDiscardHunk={(hunk) => void discardHunk(c.path, hunk)}
										/>
									{/if}
								</div>
							{/if}
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
					{committing
						? 'Committing…'
						: `Commit ${selectedFileCount} file${selectedFileCount === 1 ? '' : 's'}`}
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
	{:else if loadError}
		<!-- error is already shown; do not replace it with Loading / No commits -->
	{:else if repoId}
		<p class="empty" data-testid="git-history-empty">Loading…</p>
	{:else}
		<div class="empty-state" data-testid="git-history-empty">
			<p class="empty">No repository selected</p>
			{#if onInit}
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--primary"
					data-testid="git-init-repo"
					disabled={initBusy}
					onclick={() => void onInit()}
				>
					{initBusy ? 'Initializing…' : 'Initialize repository'}
				</button>
			{/if}
		</div>
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
		max-height: 40vh;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.change-row {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.8rem;
		min-width: 0;
	}
	.path-btn {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		padding: 0;
		border: none;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.path-btn .path,
	.rename-path {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rename-path {
		min-width: 0;
		font-size: 0.8rem;
	}
	.chevron {
		display: inline-block;
		flex: 0 0 auto;
		transition: transform 0.1s ease;
		color: var(--text-secondary, #666);
	}
	.chevron.open {
		transform: rotate(90deg);
	}
	.partial-badge {
		flex: 0 0 auto;
		font-size: 0.68rem;
		font-family: var(--font-mono, monospace);
		color: var(--accent, #6366f1);
	}
	.discard-btn {
		flex: 0 0 auto;
		margin-left: auto;
		padding: 1px 6px;
		border: 1px solid var(--line-hairline, #ccc);
		border-radius: var(--radius-sm, 4px);
		background: transparent;
		color: var(--text-secondary, #666);
		font-size: 0.68rem;
		cursor: pointer;
	}
	.discard-btn:hover:not(:disabled) {
		border-color: var(--danger, #c33);
		color: var(--danger, #c33);
	}
	.discard-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.diff-slot {
		padding: 2px 0 4px;
	}
	.diff-bulk {
		display: flex;
		gap: 10px;
		padding: 0 0 4px 20px;
	}
	.link-btn {
		padding: 0;
		border: none;
		background: transparent;
		color: var(--accent, #6366f1);
		font-size: 0.7rem;
		text-decoration: underline;
		cursor: pointer;
	}
	.link-btn:disabled {
		color: var(--text-secondary, #666);
		text-decoration: none;
		cursor: default;
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
	.st-renamed {
		color: var(--accent, #6366f1);
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
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 10px;
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
