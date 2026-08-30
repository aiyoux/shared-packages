<script lang="ts">
	/**
	 * Storage controls for one project folder.
	 *
	 * Everything here is an ACTION, not a setting. Packs never build
	 * themselves, and editing a file moves it out of its pack, so there is no
	 * "packed mode" to be in — a stored flag would be wrong the moment anyone
	 * saved. What storage looks like is read from the store each time.
	 */
	import { toast } from '@shared-packages/ui';
	import type { VfsService } from '../vfs.js';
	import type { PackOpProgress } from '../types.js';
	import {
		compactProject,
		initProject,
		packProject,
		projectStorageStats,
		readProjectMeta,
		unpackProject,
		type ProjectMeta
	} from '../projectMeta.js';
	import {
		exportProjectAsBundle,
		exportProjectAsFiles,
		importProject
	} from '../projectExport.js';

	let {
		vfs,
		rootId,
		onChanged
	}: {
		vfs: VfsService;
		rootId: string;
		onChanged?: () => void;
	} = $props();

	type Stats = Awaited<ReturnType<typeof projectStorageStats>>;

	let meta = $state<ProjectMeta | null>(null);
	let stats = $state<Stats | null>(null);
	let busy = $state('');
	let note = $state('');

	// Init form
	let initName = $state('');
	let initDescription = $state('');
	let initPack = $state(false);

	// Export options
	let exportMode = $state<'files' | 'bundle'>('files');
	let preserveMetadata = $state(true);
	// Import options
	let rebuildPacks = $state<'as-before' | 'auto' | 'none'>('as-before');

	let fileInput = $state<HTMLInputElement | null>(null);

	async function refresh() {
		meta = await readProjectMeta(vfs, rootId);
		stats = await projectStorageStats(vfs, rootId);
		if (meta && !initName) initName = meta.name;
	}

	$effect(() => {
		if (rootId) void refresh();
	});

	const report = (ev: PackOpProgress) => {
		note = ev.label;
	};

	async function run(label: string, fn: () => Promise<void>) {
		if (busy) return;
		busy = label;
		note = '';
		try {
			await fn();
			await refresh();
			onChanged?.();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : String(e));
		} finally {
			busy = '';
			note = '';
		}
	}

	function download(name: string, bytes: Uint8Array) {
		const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
		const a = document.createElement('a');
		a.href = url;
		a.download = name;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
	}

	function fmt(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
		if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
		return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
	}
</script>

<section class="panel" data-testid="project-storage-panel">
	{#if !meta}
		<div class="row head">
			<h3>This folder is not a project</h3>
			<p class="sub">
				Give it a name to track it as one. Nothing moves on disk unless you ask for it.
			</p>
		</div>
		<div class="form">
			<input
				type="text"
				placeholder="Project name"
				bind:value={initName}
				data-testid="project-init-name"
			/>
			<input
				type="text"
				placeholder="Description (optional)"
				bind:value={initDescription}
				data-testid="project-init-description"
			/>
			<label class="check">
				<input type="checkbox" bind:checked={initPack} data-testid="project-init-pack" />
				Also pack its contents now
			</label>
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--primary"
				disabled={!initName.trim() || !!busy}
				data-testid="project-init-btn"
				onclick={() =>
					run('init', async () => {
						await initProject(vfs, rootId, {
							name: initName.trim(),
							description: initDescription.trim() || undefined,
							pack: initPack,
							onProgress: report
						});
					})}
			>
				{busy === 'init' ? 'Initialising…' : 'Initialise as project'}
			</button>
		</div>
	{:else}
		<div class="row head">
			<h3 data-testid="project-name">{meta.name}</h3>
			{#if meta.description}
				<p class="sub" data-testid="project-description">{meta.description}</p>
			{/if}
		</div>

		{#if stats}
			<dl class="stats" data-testid="project-stats">
				<div><dt>Files</dt><dd data-testid="stat-files">{stats.files}</dd></div>
				<div>
					<dt>In packs</dt>
					<dd data-testid="stat-packed">
						{stats.packedFiles}<span class="of">/{stats.files}</span>
					</dd>
				</div>
				<div>
					<dt title="Files that left their pack when they were edited">Drifted out</dt>
					<dd data-testid="stat-drifted">{stats.driftedFiles}</dd>
				</div>
				<div><dt>Packs</dt><dd data-testid="stat-packs">{stats.packs}</dd></div>
				<div>
					<dt title="Space held by members that are gone">Reclaimable</dt>
					<dd data-testid="stat-dead">{fmt(stats.deadBytes)}</dd>
				</div>
			</dl>
			{#if stats.packs > 0 && stats.files > stats.packedFiles}
				<p class="hint" data-testid="project-drift-hint">
					{stats.files - stats.packedFiles} of {stats.files} files sit outside the pack{stats.driftedFiles >
					0
						? ` — ${stats.driftedFiles} drifted out when edited`
						: ''}. Nothing joins a pack on its own: files added since, and every object git
					writes, stay separate until you pack again. Packing is maintenance you repeat, not a
					setting — in an active repo the packed share drops quickly.
				</p>
			{/if}
		{/if}

		<div class="actions">
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--secondary"
				disabled={!!busy}
				data-testid="project-pack-btn"
				onclick={() => run('pack', async () => void (await packProject(vfs, rootId, { onProgress: report })))}
			>
				{busy === 'pack' ? 'Packing…' : 'Pack all'}
			</button>
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--secondary"
				disabled={!!busy}
				data-testid="project-unpack-btn"
				onclick={() =>
					run('unpack', async () => void (await unpackProject(vfs, rootId, { onProgress: report })))}
			>
				{busy === 'unpack' ? 'Unpacking…' : 'Unpack all'}
			</button>
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--secondary"
				disabled={!!busy}
				data-testid="project-compact-btn"
				onclick={() =>
					run('compact', async () => void (await compactProject(vfs, rootId, { onProgress: report })))}
			>
				{busy === 'compact' ? 'Compacting…' : 'Reclaim space'}
			</button>
		</div>

		<div class="block">
			<h4>Export</h4>
			<label class="check">
				<input
					type="radio"
					value="files"
					bind:group={exportMode}
					data-testid="project-export-mode-files"
				/>
				As a folder of files (a ZIP anything can open)
			</label>
			<label class="check">
				<input
					type="radio"
					value="bundle"
					bind:group={exportMode}
					data-testid="project-export-mode-bundle"
				/>
				As a project bundle (.sprj — keeps packs whole, only this app reads it)
			</label>
			{#if exportMode === 'files'}
				<label class="check indent">
					<input
						type="checkbox"
						bind:checked={preserveMetadata}
						data-testid="project-export-metadata"
					/>
					Preserve project metadata and pack layout
				</label>
				{#if !preserveMetadata}
					<p class="hint" data-testid="project-export-nometa-hint">
						Without it this is just files: importing later gives an ordinary folder.
					</p>
				{/if}
			{/if}
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--primary"
				disabled={!!busy}
				data-testid="project-export-btn"
				onclick={() =>
					run('export', async () => {
						const out =
							exportMode === 'bundle'
								? await exportProjectAsBundle(vfs, rootId, { onProgress: report })
								: await exportProjectAsFiles(vfs, rootId, {
										preserveMetadata,
										onProgress: report
									});
						download(out.name, out.bytes);
						toast.success(`Exported ${out.files} files as ${out.name}`);
					})}
			>
				{busy === 'export' ? 'Exporting…' : 'Export project'}
			</button>
		</div>
	{/if}

	<div class="block">
		<h4>Import</h4>
		<label class="check">
			<input
				type="radio"
				value="as-before"
				bind:group={rebuildPacks}
				data-testid="project-import-as-before"
			/>
			Rebuild packs as they were
		</label>
		<label class="check">
			<input type="radio" value="auto" bind:group={rebuildPacks} data-testid="project-import-auto" />
			Rebuild packs as the system sees fit
		</label>
		<label class="check">
			<input type="radio" value="none" bind:group={rebuildPacks} data-testid="project-import-none" />
			Do not pack — one file per blob
		</label>
		<input
			type="file"
			accept=".zip,.sprj"
			bind:this={fileInput}
			data-testid="project-import-file"
			onchange={(e) => {
				const f = (e.currentTarget as HTMLInputElement).files?.[0];
				if (!f) return;
				void run('import', async () => {
					const bytes = new Uint8Array(await f.arrayBuffer());
					const res = await importProject(vfs, null, bytes, {
						rebuildPacks,
						onProgress: report
					});
					toast.success(`Imported ${res.files} files`);
					if (fileInput) fileInput.value = '';
				});
			}}
		/>
	</div>

	{#if busy && note}
		<p class="note" data-testid="project-storage-note">{note}</p>
	{/if}
</section>

<style>
	.panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-4);
		border: 1px solid var(--line-hairline);
		border-radius: var(--radius-md);
		background: var(--surface-2);
	}
	.row.head h3 {
		margin: 0;
		font-size: var(--text-base);
		font-weight: 620;
		color: var(--text-primary);
	}
	.sub,
	.hint {
		margin: 2px 0 0;
		font-size: var(--text-xs);
		color: var(--text-muted);
		line-height: 1.55;
	}
	.form,
	.block {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.block h4 {
		margin: 0;
		font-size: var(--text-sm);
		font-weight: 600;
		color: var(--text-primary);
	}
	.form input[type='text'] {
		padding: 6px 8px;
		border: 1px solid var(--line-hairline);
		border-radius: var(--radius-sm);
		background: var(--surface-1);
		color: var(--text-primary);
		font-size: var(--text-sm);
	}
	.check {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-xs);
		color: var(--text-secondary);
	}
	.check.indent {
		padding-left: var(--space-5);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
		gap: var(--space-3);
		margin: 0;
	}
	.stats div {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.stats dt {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}
	.stats dd {
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--text-primary);
	}
	.stats dd .of {
		color: var(--text-muted);
	}
	.note {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--text-secondary);
	}
</style>
