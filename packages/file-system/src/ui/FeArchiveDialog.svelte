<script lang="ts">
	/**
	 * Compress / decompress / encrypt / decrypt FileExplorer rows using the
	 * same engines as the hub Compress / Hash & Vault tools.
	 */
	import '@shared-packages/design-system/button.css';
	import { toast } from '@shared-packages/ui';
	import { formatExplorerError } from './explorerError.js';
	import {
		CODEC_LABEL,
		defaultCodecFor,
		listEngines as listCompressEngines,
		loadEngine as loadCompressEngine,
		type Codec,
		type EngineId as CompressEngineId
	} from '@shared-packages/compress';
	import {
		listEngines as listCryptoEngines,
		loadEngine as loadCryptoEngine,
		type EngineId as CryptoEngineId
	} from '@shared-packages/crypto';
	import type { ExplorerDriver, ExplorerEntry } from './explorerDriver.js';
	import {
		COMPRESS_STORAGE_KEY,
		CRYPTO_STORAGE_KEY,
		archiveJobPhaseLabel,
		packingAsTree,
		previewArchiveEnginePlan,
		extractContainerName,
		readStoredCompressEngine,
		readStoredCryptoEngine,
		subjectLabel,
		type ArchiveDest,
		type ArchiveJobSpec,
		type ArchiveKind
	} from './archiveOps.js';

	export type { ArchiveDest, ArchiveKind };

	const KIND_TITLE: Record<ArchiveKind, string> = {
		compress: 'Compress',
		encrypt: 'Encrypt',
		decompress: 'Decompress',
		decrypt: 'Decrypt'
	};
	const KIND_BUSY: Record<ArchiveKind, string> = {
		compress: 'Compressing…',
		encrypt: 'Encrypting…',
		decompress: 'Decompressing…',
		decrypt: 'Decrypting…'
	};

	let {
		kind,
		entries,
		driver,
		destLocked = null,
		jobRunning = false,
		jobPct = 0,
		jobLabel = '',
		onLaunch,
		onHide,
		onAbort,
		onCancel
	}: {
		kind: ArchiveKind;
		entries: ExplorerEntry[];
		driver: ExplorerDriver;
		destLocked?: ArchiveDest | null;
		jobRunning?: boolean;
		jobPct?: number;
		jobLabel?: string;
		onLaunch: (spec: ArchiveJobSpec) => void;
		onHide?: () => void;
		onAbort?: () => void;
		onCancel: () => void;
	} = $props();

	const compressEngines = listCompressEngines();
	const cryptoEngines = listCryptoEngines();
	const isExtract = $derived(kind === 'decompress' || kind === 'decrypt');
	const isCrypto = $derived(kind === 'encrypt' || kind === 'decrypt');
	const treePack = $derived(packingAsTree(entries));
	const titleName = $derived(subjectLabel(entries));

	let dest = $state<ArchiveDest>('same');
	let compressEngineId = $state<CompressEngineId>(readStoredCompressEngine());
	let codec = $state<Codec>(defaultCodecFor(readStoredCompressEngine()));
	let cryptoEngineId = $state<CryptoEngineId>(readStoredCryptoEngine());
	let password = $state('');
	let password2 = $state('');
	let engineStatus = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	let engineError = $state('');
	let busy = $state(false);
	let actionError = $state('');
	let pickParent = $state<string | null>(null);
	let pickFolders = $state<ExplorerEntry[]>([]);
	let pickCrumbs = $state<ExplorerEntry[]>([]);
	let pickBusy = $state(false);
	/** Monitor host format (zip stays on the computer). */
	let hostFormat = $state<'zip' | 'tar' | 'tgz'>('zip');
	/** Monitor default is on-host; opt into the download → process → upload path. */
	let where = $state<'host' | 'browser'>('host');
	let destName = $state('');
	/** Finder `__MACOSX` / `._*` / `.DS_Store` — on by default, uncheck to keep them. */
	let skipSystemFiles = $state(true);
	/** Extract into a new folder named after the archive. Default on. */
	let wrapInSubfolder = $state(true);
	let abortRequested = $state(false);

	const compressEngine = $derived(
		compressEngines.find((e) => e.id === compressEngineId) ?? compressEngines[0]!
	);
	const cryptoEngine = $derived(cryptoEngines.find((e) => e.id === cryptoEngineId) ?? cryptoEngines[0]!);
	const availableCodecs = $derived.by((): Codec[] => {
		if (!(treePack && kind === 'compress')) return [...compressEngine.codecs];
		const containers = compressEngine.codecs.filter((c) => c === 'zip' || c === 'tar');
		return containers.length ? [...containers] : ['zip'];
	});
	const isMonitor = $derived(driver.id === 'monitor');
	const canHost = $derived(
		isMonitor && typeof driver.archive === 'function' && typeof driver.absolutePath === 'function'
	);
	const useHost = $derived(canHost && where === 'host' && destLocked == null);
	const enginePlan = $derived(
		previewArchiveEnginePlan({
			kind,
			entries,
			compressEngineId,
			codec,
			cryptoEngineId,
			useHost
		})
	);
	const isShuttle = $derived(
		driver.id === 'b2' || driver.id === 'rclone' || (isMonitor && !useHost)
	);
	const canPickFolder = $derived(driver.capabilities.supportsMkdir || useHost);
	const alreadyMemory = $derived(driver.id === 'memory');
	const canWriteHere = $derived(Boolean(driver.writeFile || driver.upload) || useHost);
	const shuttleVerb = $derived(
		kind === 'compress'
			? 'compresses'
			: kind === 'encrypt'
				? 'encrypts'
				: kind === 'decompress'
					? 'decompresses'
					: 'decrypts'
	);
	const defaultPackName = $derived.by(() => {
		const raw = entries.length === 1 ? entries[0]!.name.replace(/\/+$/, '') : 'archive';
		if (kind === 'encrypt') return `${raw}.spvault`;
		const stem = raw.includes('.') && entries.length === 1 && entries[0]!.kind === 'file'
			? raw.replace(/\.[^./]+$/, '')
			: raw;
		if (useHost) {
			if (hostFormat === 'tar') return `${stem}.tar`;
			if (hostFormat === 'tgz') return `${stem}.tar.gz`;
			return `${stem}.zip`;
		}
		return `${stem}.zip`;
	});

	$effect(() => {
		if (destLocked) dest = destLocked;
	});

	$effect(() => {
		if (destLocked || !canHost) where = 'browser';
	});

	$effect(() => {
		if (useHost && (dest === 'memory' || dest === 'popup')) dest = 'same';
	});

	$effect(() => {
		destName = defaultPackName;
	});

	$effect(() => {
		if (destLocked) return;
		if (dest === 'same' && !canWriteHere && !alreadyMemory) dest = isExtract ? 'popup' : 'memory';
	});

	$effect(() => {
		if (kind === 'compress' && treePack && codec !== 'zip' && codec !== 'tar') codec = 'zip';
	});

	$effect(() => {
		if (!availableCodecs.includes(codec) && availableCodecs.length) codec = availableCodecs[0]!;
	});

	$effect(() => {
		if (useHost || kind === 'decrypt') {
			engineStatus = 'ready';
			engineError = '';
			if (useHost) return;
			if (kind === 'decrypt') return;
		}
		const requested = isCrypto ? cryptoEngineId : compressEngineId;
		const used = enginePlan.roles[0]?.used ?? requested;
		let cancelled = false;
		engineStatus = 'loading';
		engineError = '';
		const loadUsed = isCrypto
			? loadCryptoEngine(used as CryptoEngineId)
			: loadCompressEngine(used as CompressEngineId);
		void loadUsed
			.then(() => {
				if (!cancelled) engineStatus = 'ready';
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				engineStatus = 'error';
				engineError = err instanceof Error ? err.message : 'Failed to load engine';
			});
		if (!isCrypto && used !== requested) {
			void loadCompressEngine(requested as CompressEngineId).catch(() => {
				/* selected library is not required when a fallback will run */
			});
		}
		try {
			localStorage.setItem(
				isCrypto ? CRYPTO_STORAGE_KEY : COMPRESS_STORAGE_KEY,
				requested
			);
		} catch {
			/* ignore */
		}
		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		if (pickParent === null) pickParent = entries[0]?.parentId ?? null;
	});

	$effect(() => {
		if (dest !== 'folder') return;
		void loadPick(pickParent);
	});

	async function loadPick(parentId: string | null) {
		pickBusy = true;
		try {
			const listed = await driver.list({ parentId });
			pickFolders = listed.entries.filter((e) => e.kind === 'folder');
			pickCrumbs = parentId ? await driver.getPath(parentId) : [];
		} catch (e) {
			actionError = formatExplorerError(e);
			toast.error(actionError);
		} finally {
			pickBusy = false;
		}
	}

	const canRun = $derived(
		engineStatus === 'ready' &&
			!busy &&
			!jobRunning &&
			(dest !== 'same' || canWriteHere) &&
			(dest !== 'folder' || canPickFolder) &&
			(kind !== 'encrypt' || (password.length > 0 && password === password2)) &&
			(kind !== 'decrypt' || password.length > 0) &&
			(!useHost || destName.trim().length > 0 || isExtract)
	);

	function hostOp(): 'zip' | 'tar' | 'tgz' | 'encrypt' | 'unzip' | 'untar' | 'decrypt' {
		if (kind === 'encrypt') return 'encrypt';
		if (kind === 'decrypt') return 'decrypt';
		if (kind === 'compress') return hostFormat;
		const name = entries[0]?.name.toLowerCase() ?? '';
		if (name.endsWith('.spvault')) return 'decrypt';
		if (name.endsWith('.zip')) return 'unzip';
		return 'untar';
	}

	function hostDestPath(): string {
		const parentId = dest === 'folder' ? pickParent : (entries[0]?.parentId ?? null);
		const parentAbs = driver.absolutePath!(parentId);
		const parent = parentAbs.replace(/\/+$/, '');
		if (isExtract) {
			if (wrapInSubfolder && (dest === 'same' || dest === 'folder')) {
				const stem = extractContainerName(entries[0]?.name ?? 'archive');
				return `${parent}/${stem}`;
			}
			return parentAbs;
		}
		const name = destName.trim() || defaultPackName;
		return `${parent}/${name}`;
	}

	const showWrapSubfolder = $derived(isExtract && (dest === 'same' || dest === 'folder'));

	const destParentId = $derived(
		dest === 'folder' ? pickParent : (entries[0]?.parentId ?? null)
	);
	const running = $derived(busy || jobRunning);
	const shownPct = $derived(jobRunning ? jobPct : 0);
	$effect(() => {
		if (!running) abortRequested = false;
	});
	const progressLabel = $derived(
		abortRequested || jobLabel === 'Cancelling…'
			? 'Cancelling…'
			: jobLabel ||
				archiveJobPhaseLabel({
					kind,
					entries,
					compressEngineId,
					codec,
					cryptoEngineId,
					useHost
				})
	);

	const runLabel = $derived.by(() => {
		if (running) {
			const pct = ` ${shownPct}%`;
			return `${KIND_BUSY[kind]}${pct}`;
		}
		if (dest === 'popup') return 'Open';
		if (useHost) {
			return kind === 'compress'
				? 'Zip on this computer'
				: kind === 'encrypt'
					? 'Encrypt on this computer'
					: kind === 'decompress'
						? 'Extract on this computer'
						: 'Decrypt on this computer';
		}
		if (isShuttle) {
			return kind === 'compress'
				? 'Download, compress, and upload'
				: kind === 'encrypt'
					? 'Download, encrypt, and upload'
					: kind === 'decompress'
						? 'Download, decompress, and upload'
						: 'Download, decrypt, and upload';
		}
		return KIND_TITLE[kind];
	});

	function run() {
		if (!canRun) return;
		busy = true;
		actionError = '';
		onLaunch({
			kind,
			entries,
			driver,
			dest,
			destParentId,
			title: titleName,
			outputName: destName.trim() || defaultPackName,
			compressEngineId,
			codec,
			cryptoEngineId,
			password,
			skipSystemFiles,
			wrapInSubfolder: showWrapSubfolder && wrapInSubfolder,
			useHost,
			hostOp: useHost ? hostOp() : undefined,
			hostDestPath: useHost ? hostDestPath() : undefined
		});
	}
</script>

<div
	class="modal-root"
	data-testid="fe-archive-dialog"
	data-kind={kind}
	data-where={useHost ? 'host' : 'browser'}
	data-busy={running ? 'true' : undefined}
	data-engine-fallback={enginePlan.fallback ? 'true' : 'false'}
	role="dialog"
	aria-modal="true"
	aria-labelledby="fe-archive-title"
>
	<div class="scrim" onclick={() => (running ? onHide?.() : onCancel())} role="presentation"></div>
	<div class="card">
		<h2 id="fe-archive-title">
			{#if useHost}
				{kind === 'compress'
					? 'Zip'
					: kind === 'encrypt'
						? 'Encrypt'
						: kind === 'decompress'
							? 'Extract'
							: 'Decrypt'}
				{titleName} on this computer
			{:else}
				{KIND_TITLE[kind]} {titleName}
			{/if}
		</h2>

		{#if useHost}
			<p class="path-note host" data-testid="fe-archive-path-note">
				Runs on the monitor computer. Files are not downloaded to this browser.
			</p>
		{:else if isShuttle}
			<p class="path-note shuttle" data-testid="fe-archive-path-note">
				This downloads the files to this browser, {shuttleVerb} them here, then uploads the
				result.
			</p>
		{/if}

		{#if kind === 'compress' && useHost}
			<div class="fields">
				<label>
					<span>Format</span>
					<select bind:value={hostFormat} data-testid="fe-archive-host-format">
						<option value="zip">ZIP</option>
						<option value="tgz">tar.gz</option>
						<option value="tar">tar (uncompressed)</option>
					</select>
				</label>
				<label>
					<span>Output name</span>
					<input type="text" bind:value={destName} data-testid="fe-archive-dest-name" autocomplete="off" />
				</label>
			</div>
			<p class="hint">Creates the archive next to the original files on this computer.</p>
		{:else if kind === 'compress'}
			<div class="fields">
				<label>
					<span>Library</span>
					<select bind:value={compressEngineId} data-testid="fe-archive-engine">
						{#each compressEngines as engine (engine.id)}
							<option value={engine.id}>{engine.label}</option>
						{/each}
					</select>
				</label>
				<label>
					<span>Format</span>
					<select bind:value={codec} data-testid="fe-archive-codec" disabled={treePack}>
						{#each availableCodecs as c (c)}
							<option value={c}>{CODEC_LABEL[c]}</option>
						{/each}
					</select>
				</label>
			</div>
			<p class="hint">
				{compressEngine.description}{treePack
					? ' · Multiple items pack as a ZIP inner filesystem.'
					: ''}
			</p>
		{:else if kind === 'encrypt'}
			<div class="fields">
				{#if !useHost}
					<label>
						<span>Library</span>
						<select bind:value={cryptoEngineId} data-testid="fe-archive-engine">
							{#each cryptoEngines as engine (engine.id)}
								<option value={engine.id}>{engine.label}</option>
							{/each}
						</select>
					</label>
				{/if}
				<label>
					<span>Password</span>
					<input type="password" autocomplete="new-password" bind:value={password} data-testid="fe-archive-password" />
				</label>
				<label>
					<span>Confirm</span>
					<input
						type="password"
						autocomplete="new-password"
						bind:value={password2}
						data-testid="fe-archive-password-confirm"
					/>
				</label>
				{#if useHost}
					<label>
						<span>Output name</span>
						<input type="text" bind:value={destName} data-testid="fe-archive-dest-name" autocomplete="off" />
					</label>
				{/if}
			</div>
			<p class="hint">
				{#if useHost}
					Writes a Scratch Pad vault (.spvault) on this computer. The original files stay in place.
				{:else}
					{cryptoEngine.description} · {cryptoEngine.aead} · {cryptoEngine.kdf}{treePack
						? ' · Multiple items seal as a vault tree.'
						: ''}
				{/if}
			</p>
		{:else if kind === 'decompress'}
			{#if !useHost}
				<div class="fields">
					<label>
						<span>Library</span>
						<select bind:value={compressEngineId} data-testid="fe-archive-engine">
							{#each compressEngines as engine (engine.id)}
								<option value={engine.id}>{engine.label}</option>
							{/each}
						</select>
					</label>
					<label class="check-row">
						<input
							type="checkbox"
							bind:checked={skipSystemFiles}
							data-testid="fe-archive-skip-system"
						/>
						Skip system files
					</label>
				</div>
				<p class="hint">
					{compressEngine.description} · Format is detected from the file.{skipSystemFiles
						? ' · Skips macOS __MACOSX / ._ files and .DS_Store.'
						: ''}
				</p>
			{:else}
				<p class="hint">Extracts into the folder you choose on this computer.</p>
			{/if}
		{:else}
			<div class="fields">
				<label>
					<span>Password</span>
					<input
						type="password"
						autocomplete="current-password"
						bind:value={password}
						data-testid="fe-archive-password"
					/>
				</label>
				{#if !useHost}
					<label class="check-row">
						<input
							type="checkbox"
							bind:checked={skipSystemFiles}
							data-testid="fe-archive-skip-system"
						/>
						Skip system files
					</label>
				{/if}
			</div>
			<p class="hint">
				{#if useHost}
					Decrypts the vault on this computer. The .spvault file is left in place.
				{:else}
					Unlocks a Scratch Pad vault (.spvault).
				{/if}
			</p>
		{/if}

		{#if enginePlan.lines.length}
			<p
				class="engine-note"
				class:fallback={enginePlan.fallback}
				data-testid="fe-archive-engine-note"
				data-fallback={enginePlan.fallback ? 'true' : 'false'}
			>
				{enginePlan.lines.join(' ')}
			</p>
		{/if}

		{#if engineStatus === 'loading'}
			<p class="hint">Loading engine…</p>
		{:else if engineStatus === 'error'}
			<p class="err" role="alert">{engineError}</p>
		{/if}

		{#if canHost && !destLocked}
			<fieldset class="dest where" data-testid="fe-archive-where">
				<legend>Where it runs</legend>
				<label>
					<input
						type="radio"
						name="fe-archive-where"
						value="host"
						bind:group={where}
						data-testid="fe-archive-where-host"
					/>
					On this computer (no download)
				</label>
				<label>
					<input
						type="radio"
						name="fe-archive-where"
						value="browser"
						bind:group={where}
						data-testid="fe-archive-where-browser"
					/>
					In this browser (download, then upload)
				</label>
			</fieldset>
		{/if}

		{#if !destLocked}
			<fieldset class="dest">
				<legend>{isExtract ? 'Extract to' : 'Save to'}</legend>
				<label>
					<input
						type="radio"
						name="fe-archive-dest"
						value="same"
						bind:group={dest}
						disabled={!canWriteHere}
						data-testid="fe-archive-dest-same"
					/>
					{useHost ? 'Same folder on this computer' : 'Same folder'}
				</label>
				{#if canPickFolder}
					<label>
						<input type="radio" name="fe-archive-dest" value="folder" bind:group={dest} />
						Choose folder…
					</label>
				{/if}
				{#if !alreadyMemory && !useHost}
					<label>
						<input
							type="radio"
							name="fe-archive-dest"
							value="memory"
							bind:group={dest}
							data-testid="fe-archive-dest-memory"
						/>
						In-memory storage
					</label>
				{/if}
				{#if isExtract && !useHost}
					<label>
						<input
							type="radio"
							name="fe-archive-dest"
							value="popup"
							bind:group={dest}
							data-testid="fe-archive-dest-popup"
						/>
						Open in popup
					</label>
				{/if}
			</fieldset>
		{:else if destLocked === 'popup'}
			<p class="hint">Contents open as an inner filesystem in a popup.</p>
		{/if}

		{#if showWrapSubfolder}
			<label class="check-row wrap-sub" data-testid="fe-archive-wrap-subfolder-row">
				<input
					type="checkbox"
					bind:checked={wrapInSubfolder}
					data-testid="fe-archive-wrap-subfolder"
				/>
				{kind === 'decrypt'
					? 'Create sub folder with same name as vault'
					: 'Create sub folder with same name as zip'}
			</label>
		{/if}

		{#if dest === 'folder'}
			<div class="picker" data-testid="fe-archive-folder-pick">
				<div class="crumbs">
					<button type="button" class="ds-btn ds-btn--sm ds-btn--ghost" onclick={() => (pickParent = null)}>
						Root
					</button>
					{#each pickCrumbs as crumb (crumb.id)}
						<span>/</span>
						<button type="button" class="ds-btn ds-btn--sm ds-btn--ghost" onclick={() => (pickParent = crumb.id)}>
							{crumb.name}
						</button>
					{/each}
				</div>
				{#if pickBusy}
					<p class="hint">Loading folders…</p>
				{:else if pickFolders.length === 0}
					<p class="hint">No subfolders here — this folder will be used.</p>
				{:else}
					<ul>
						{#each pickFolders as folder (folder.id)}
							<li>
								<button type="button" class="folder-btn" onclick={() => (pickParent = folder.id)}>
									{folder.name}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}

		{#if actionError}
			<p class="err" role="alert" data-testid="fe-archive-error">{actionError}</p>
		{/if}

		{#if running}
			<div class="progress" data-testid="fe-archive-progress">
				<div
					class="progress-bar"
					role="progressbar"
					aria-valuemin="0"
					aria-valuemax="100"
					aria-valuenow={shownPct}
				>
					<div class="progress-fill" style="width: {shownPct}%"></div>
				</div>
				<span class="progress-label">{progressLabel} {shownPct}%</span>
			</div>
		{/if}

		<div class="actions">
			{#if running}
				<button type="button" class="ds-btn ds-btn--sm ds-btn--ghost" data-testid="fe-archive-hide" onclick={() => onHide?.()}>
					Hide
				</button>
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--ghost"
					data-testid="fe-archive-abort"
					disabled={abortRequested}
					onclick={() => {
						abortRequested = true;
						onAbort?.();
					}}
				>
					{abortRequested ? 'Cancelling…' : 'Cancel'}
				</button>
			{:else}
				<button type="button" class="ds-btn ds-btn--sm ds-btn--ghost" data-testid="fe-archive-cancel" onclick={onCancel}>
					Cancel
				</button>
				<button
					type="button"
					class="ds-btn ds-btn--sm ds-btn--primary"
					data-testid="fe-archive-run"
					disabled={!canRun}
					onclick={() => run()}
				>
					{runLabel}
				</button>
			{/if}
		</div>
	</div>
</div>

<style>
	.modal-root {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.progress {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin: 0 0 0.65rem;
	}
	.progress-bar {
		height: 8px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--text-primary, #e2e8f0) 14%, transparent);
		overflow: hidden;
	}
	.progress-fill {
		height: 100%;
		background: var(--accent, #38bdf8);
	}
	.progress-label {
		font-size: 0.78rem;
		color: var(--text-muted);
	}
	.scrim {
		position: absolute;
		inset: 0;
		background: rgb(var(--scrim-rgb) / 0.55);
	}
	.card {
		position: relative;
		z-index: 1;
		width: min(440px, calc(100vw - 2rem));
		max-height: min(80vh, 640px);
		overflow: auto;
		padding: 1.1rem 1.2rem;
		background: var(--surface-2);
		border: 1px solid var(--line-hairline);
		color: var(--text-primary);
	}
	h2 {
		margin: 0 0 0.75rem;
		font-size: 1rem;
		word-break: break-word;
	}
	.fields {
		display: grid;
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.8rem;
	}
	label.check-row {
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
	}
	label.wrap-sub {
		margin: 0 0 0.65rem;
		font-size: 0.85rem;
	}
	select,
	input[type='password'],
	input[type='text'] {
		font: inherit;
		padding: 0.35rem 0.5rem;
		border: 1px solid var(--line-hairline);
		background: var(--surface-1);
		color: inherit;
		border-radius: var(--radius-md);
	}
	.hint {
		margin: 0 0 0.65rem;
		font-size: 0.78rem;
		color: var(--text-muted);
	}
	.path-note {
		margin: 0 0 0.75rem;
		padding: 0.5rem 0.65rem;
		font-size: 0.82rem;
		line-height: 1.35;
		border: 1px solid var(--line-hairline);
	}
	.path-note.shuttle {
		border-color: var(--accent);
		color: var(--text-primary);
		background: rgb(var(--accent-rgb) / 0.08);
	}
	.path-note.host {
		background: var(--surface-1);
	}
	.engine-note {
		margin: 0 0 0.65rem;
		padding: 0.5rem 0.65rem;
		font-size: 0.82rem;
		line-height: 1.35;
		border: 1px solid var(--line-hairline);
		background: var(--surface-1);
	}
	.engine-note.fallback {
		border-color: var(--accent);
		color: var(--text-primary);
		background: rgb(var(--accent-rgb) / 0.08);
	}
	.err {
		margin: 0 0 0.5rem;
		color: var(--cat-red-soft);
		font-size: 0.82rem;
	}
	.dest {
		border: 1px solid var(--line-hairline);
		margin: 0 0 0.65rem;
		padding: 0.5rem 0.65rem;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.dest legend {
		padding: 0 0.25rem;
		font-size: 0.75rem;
		color: var(--text-muted);
	}
	.dest label {
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
	}
	.picker {
		margin: 0 0 0.65rem;
		padding: 0.45rem;
		border: 1px solid var(--line-hairline);
		max-height: 10rem;
		overflow: auto;
	}
	.crumbs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem;
		margin-bottom: 0.35rem;
	}
	.picker ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.folder-btn {
		display: block;
		width: 100%;
		text-align: left;
		background: none;
		border: 0;
		color: var(--accent-light);
		font: inherit;
		padding: 0.25rem 0.15rem;
		cursor: pointer;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
