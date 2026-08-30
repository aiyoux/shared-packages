<script lang="ts">
	/**
	 * Storage inspector + integrity check, in one dialog.
	 *
	 * Used by both the file manager ("Storage" / "Check filesystem integrity")
	 * and the Projects app ("Check project integrity"), so the two apps show
	 * the same picture and the same verdict. `scope` decides which:
	 *   filesystem — maps everything, checks every live file
	 *   project    — maps one project subtree, checks just its packs
	 */
	import '@shared-packages/design-system/button.css';
	import FeStorageInspector from './FeStorageInspector.svelte';
	import { buildStorageTree } from './storageInspect.js';
	import { formatSize, type TreemapInput, type TreemapRect } from './sizeTreemap.js';
	import {
		checkFilesystem,
		checkProjectPacks,
		readProjectManifest,
		type PackIntegrityReport,
		type ProjectPackManifest
	} from '../projectPack.js';
	import type { VfsService } from '../vfs.js';

	let {
		vfs,
		scope = 'filesystem',
		rootId = null,
		title,
		onClose,
		onOpenEntry
	}: {
		vfs: VfsService;
		scope?: 'filesystem' | 'project';
		/** Project root when scope is 'project'; the mapped folder otherwise. */
		rootId?: string | null;
		title?: string;
		onClose: () => void;
		onOpenEntry?: (rect: TreemapRect) => void;
	} = $props();

	let tree = $state<TreemapInput[]>([]);
	let loading = $state(true);
	let checking = $state(false);
	let reclaiming = $state(false);
	let reclaimed = $state<string>('');
	let report = $state<PackIntegrityReport | null>(null);
	let manifest = $state<ProjectPackManifest | null>(null);
	let error = $state('');

	const heading = $derived(title ?? (scope === 'project' ? 'Project storage' : 'Storage'));
	const checkLabel = $derived(
		scope === 'project' ? 'Check project integrity' : 'Check filesystem integrity'
	);

	$effect(() => {
		let cancelled = false;
		loading = true;
		error = '';
		void (async () => {
			try {
				const built = await buildStorageTree(vfs, rootId);
				if (cancelled) return;
				tree = built;
				if (scope === 'project' && rootId) {
					manifest = await readProjectManifest(vfs, rootId);
				}
			} catch (e) {
				if (!cancelled) error = e instanceof Error ? e.message : 'Could not read storage';
			} finally {
				if (!cancelled) loading = false;
			}
		})();
		return () => {
			cancelled = true;
		};
	});

	async function runCheck() {
		checking = true;
		report = null;
		error = '';
		try {
			report =
				scope === 'project' && rootId
					? await checkProjectPacks(vfs, rootId)
					: await checkFilesystem(vfs);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Integrity check failed';
		} finally {
			checking = false;
		}
	}

	/**
	 * Reclaim what the check calls garbage.
	 *
	 * The report could name orphaned packs and stray blobs but offered no way
	 * to act on them, so the only thing left to try was deleting real files —
	 * which cannot help, because an orphan is by definition what no file
	 * points at. `gc()` removes exactly the set the check reports (both ask
	 * the same question: does any blobRef name this path?), so re-running the
	 * check afterwards is the honest proof it worked.
	 *
	 * It normally runs on its own a couple of seconds after a page load; this
	 * is the same sweep on demand, for when you are standing in front of the
	 * report and want it gone now.
	 */
	async function runReclaim() {
		reclaiming = true;
		reclaimed = '';
		error = '';
		try {
			const swept = await vfs.gc();
			const files =
				swept.orphanOpfsRemoved + swept.unreferencedBlobsRemoved + swept.tmpPartialsRemoved;
			reclaimed = files
				? `Reclaimed ${files} unused file${files === 1 ? '' : 's'}.`
				: 'Nothing to reclaim — every file on disk is still spoken for.';
			// Re-check so the verdict reflects what was just swept rather than
			// leaving a stale list of problems that no longer exist.
			if (report) await runCheck();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not reclaim storage';
		} finally {
			reclaiming = false;
		}
	}
</script>

<div class="wrap" role="dialog" aria-modal="true" aria-label={heading} data-testid="fe-storage-dialog">
	<button type="button" class="scrim" aria-label="Close" onclick={onClose}></button>
	<div class="card">
		<h2>{heading}</h2>

		{#if loading}
			<p class="muted" data-testid="fe-storage-loading">Reading storage…</p>
		{:else}
			<FeStorageInspector roots={tree} title={heading} onSelect={onOpenEntry} />
		{/if}

		{#if manifest}
			<dl class="facts" data-testid="fe-storage-manifest">
				<div><dt>Packs</dt><dd>{manifest.packPaths.length}</dd></div>
				<div><dt>Packed files</dt><dd>{manifest.packedFiles}</dd></div>
				<div><dt>Standalone files</dt><dd>{manifest.standaloneFiles}</dd></div>
				<div><dt>On disk</dt><dd>{formatSize(manifest.packBytesOnDisk)}</dd></div>
				<div>
					<dt>Reclaimable</dt>
					<dd class:warn={manifest.deadBytes > 0}>{formatSize(manifest.deadBytes)}</dd>
				</div>
			</dl>
			{#if manifest.deadBytes > 0}
				<p class="muted small">
					Space inside packs that no longer belongs to a file. It is reclaimed when you
					delete from this project, or when the last member of a pack goes.
				</p>
			{/if}
		{/if}

		{#if error}
			<p class="error" role="alert" data-testid="fe-storage-error">{error}</p>
		{/if}

		{#if report}
			<div
				class="verdict"
				class:ok={report.ok}
				role="status"
				data-testid="fe-storage-verdict"
			>
				{#if report.ok}
					Success! Checked {report.checked} files across {report.packPaths.length} pack{report
						.packPaths.length === 1
						? ''
						: 's'} — integrity verified.
				{:else}
					{report.issues.length} problem{report.issues.length === 1 ? '' : 's'} found in
					{report.checked} files.
				{/if}
			</div>
			{#if !report.ok}
				<ul class="issues" data-testid="fe-storage-issues">
					{#each report.issues.slice(0, 12) as issue}
						<li><code>{issue.kind}</code> {issue.detail}</li>
					{/each}
					{#if report.issues.length > 12}
						<li class="muted">…and {report.issues.length - 12} more</li>
					{/if}
				</ul>
				{#if report.issues.some((i) => i.kind === 'orphan-pack')}
					<p class="muted small" data-testid="fe-storage-orphan-hint">
						An orphaned pack is storage no file points at — wasted space, not damage.
						Deleting files cannot clear it; “Reclaim unused storage” can.
					</p>
				{/if}
			{/if}
		{/if}

		{#if reclaimed}
			<p class="muted small" role="status" data-testid="fe-storage-reclaimed">{reclaimed}</p>
		{/if}

		<div class="actions">
			<button
				type="button"
				class="ds-btn ds-btn--sm"
				data-testid="fe-storage-check"
				disabled={checking || reclaiming}
				onclick={() => void runCheck()}
			>
				{checking ? 'Checking…' : checkLabel}
			</button>
			{#if scope !== 'project'}
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--ghost"
					data-testid="fe-storage-reclaim"
					disabled={checking || reclaiming}
					title="Delete pack and blob files that no file points at any more"
					onclick={() => void runReclaim()}
				>
					{reclaiming ? 'Reclaiming…' : 'Reclaim unused storage'}
				</button>
			{/if}
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--ghost"
				data-testid="fe-storage-close"
				onclick={onClose}
			>
				Close
			</button>
		</div>
	</div>
</div>

<style>
	.wrap {
		position: fixed;
		inset: 0;
		display: grid;
		place-items: center;
		z-index: 60;
	}
	.scrim {
		position: absolute;
		inset: 0;
		border: 0;
		padding: 0;
		background: rgb(var(--scrim-rgb) / 0.55);
		cursor: pointer;
	}
	.card {
		position: relative;
		z-index: 1;
		width: min(720px, calc(100vw - 2rem));
		max-height: min(86vh, 780px);
		overflow: auto;
		padding: 1.1rem 1.2rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		background: var(--surface-2);
		border: 1px solid var(--line-hairline);
		border-radius: var(--radius-md);
		color: var(--text-primary);
	}
	h2 {
		margin: 0;
		font-size: 1.05rem;
		font-weight: 600;
	}
	.muted {
		color: var(--text-muted);
		margin: 0;
		font-size: 0.85rem;
	}
	.small {
		font-size: 0.78rem;
	}
	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1.25rem;
		margin: 0;
		font-size: 0.8rem;
	}
	.facts div {
		display: flex;
		gap: 0.35rem;
		align-items: baseline;
	}
	.facts dt {
		color: var(--text-muted);
	}
	.facts dd {
		margin: 0;
		font-variant-numeric: tabular-nums;
	}
	.facts dd.warn {
		color: var(--cat-red-soft, var(--accent));
	}
	.verdict {
		font-size: 0.85rem;
		padding: 0.5rem 0.65rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--line-hairline);
	}
	.verdict.ok {
		border-color: var(--accent);
	}
	.issues {
		margin: 0;
		padding-left: 1.1rem;
		font-size: 0.78rem;
		color: var(--text-muted);
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.error {
		margin: 0;
		font-size: 0.85rem;
		color: var(--cat-red-soft, var(--accent));
	}
	.actions {
		display: flex;
		gap: 0.5rem;
		justify-content: flex-end;
	}
</style>
