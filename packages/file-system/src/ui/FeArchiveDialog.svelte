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
		engineSupports,
		listEngines as listCompressEngines,
		loadEngine as loadCompressEngine,
		packFiles,
		type Codec,
		type EngineId as CompressEngineId
	} from '@shared-packages/compress';
	import {
		listEngines as listCryptoEngines,
		loadEngine as loadCryptoEngine,
		sealVault,
		type EngineId as CryptoEngineId
	} from '@shared-packages/crypto';
	import { getMemoryVfs } from '../memoryVfs.js';
	import { createMemoryExplorerDriver } from './memoryExplorerDriver.js';
	import type { ExplorerDriver, ExplorerEntry } from './explorerDriver.js';
	import {
		COMPRESS_STORAGE_KEY,
		CRYPTO_STORAGE_KEY,
		collectPackEntries,
		expandPackedBytes,
		packingAsTree,
		readStoredCompressEngine,
		readStoredCryptoEngine,
		subjectLabel,
		toArchiveEntries,
		writeEntriesToDriver,
		type ArchiveDest,
		type ArchiveKind,
		type PackedPath
	} from './archiveOps.js';

	export type { ArchiveDest, ArchiveKind };

	export type ArchiveDone = {
		inner?: PackedPath[];
		title: string;
	};

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
		onDone,
		onCancel
	}: {
		kind: ArchiveKind;
		entries: ExplorerEntry[];
		driver: ExplorerDriver;
		destLocked?: ArchiveDest | null;
		onDone: (result?: ArchiveDone) => void;
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

	const compressEngine = $derived(
		compressEngines.find((e) => e.id === compressEngineId) ?? compressEngines[0]!
	);
	const cryptoEngine = $derived(cryptoEngines.find((e) => e.id === cryptoEngineId) ?? cryptoEngines[0]!);
	const availableCodecs = $derived(
		treePack && kind === 'compress'
			? compressEngine.codecs.filter((c) => c === 'zip' || c === 'tar')
			: compressEngine.codecs
	);
	const canPickFolder = $derived(driver.capabilities.supportsMkdir);
	const alreadyMemory = $derived(driver.id === 'memory');
	const canWriteHere = $derived(Boolean(driver.writeFile || driver.upload));

	$effect(() => {
		if (destLocked) dest = destLocked;
	});

	$effect(() => {
		if (destLocked) return;
		if (dest === 'same' && !canWriteHere && !alreadyMemory) dest = isExtract ? 'popup' : 'memory';
	});

	$effect(() => {
		if (kind === 'compress' && treePack) {
			// Multi-file packing needs a container codec (zip or tar).
			// If the current engine can't do containers, switch to one that can.
			if (!engineSupports(compressEngineId, 'zip') && !engineSupports(compressEngineId, 'tar')) {
				const zipEngine = compressEngines.find((e) => e.codecs.includes('zip'));
				if (zipEngine) compressEngineId = zipEngine.id;
			}
			if (codec !== 'zip' && codec !== 'tar') codec = 'zip';
		}
	});

	$effect(() => {
		if (!availableCodecs.includes(codec) && availableCodecs.length) codec = availableCodecs[0]!;
	});

	// Auto-switch engine when the selected codec isn't supported by the current engine.
	$effect(() => {
		if (kind !== 'compress') return;
		if (codec === 'tar' && !engineSupports(compressEngineId, 'tar')) {
			const tarEngine = compressEngines.find((e) => e.codecs.includes('tar'));
			if (tarEngine) compressEngineId = tarEngine.id;
		}
		if (codec === 'zip' && !engineSupports(compressEngineId, 'zip')) {
			const zipEngine = compressEngines.find((e) => e.codecs.includes('zip'));
			if (zipEngine) compressEngineId = zipEngine.id;
		}
	});

	$effect(() => {
		if (kind === 'decrypt') {
			engineStatus = 'ready';
			engineError = '';
			return;
		}
		const id = isCrypto ? cryptoEngineId : compressEngineId;
		let cancelled = false;
		engineStatus = 'loading';
		engineError = '';
		const load = isCrypto
			? loadCryptoEngine(id as CryptoEngineId)
			: loadCompressEngine(id as CompressEngineId);
		void load
			.then(() => {
				if (!cancelled) engineStatus = 'ready';
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				engineStatus = 'error';
				engineError = err instanceof Error ? err.message : 'Failed to load engine';
			});
		try {
			localStorage.setItem(isCrypto ? CRYPTO_STORAGE_KEY : COMPRESS_STORAGE_KEY, id);
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
			(dest !== 'same' || canWriteHere) &&
			(dest !== 'folder' || canPickFolder) &&
			(kind !== 'encrypt' || (password.length > 0 && password === password2)) &&
			(kind !== 'decrypt' || password.length > 0)
	);

	async function run() {
		if (!canRun) return;
		busy = true;
		actionError = '';
		try {
			if (kind === 'compress' || kind === 'encrypt') {
				const packed = await collectPackEntries(driver, entries);
				if (kind === 'compress') {
					const out = await packFiles(compressEngineId, toArchiveEntries(packed), codec);
					await writeOutputs(out.map((f) => ({ path: f.name, data: f.data })));
				} else {
					const sealed = await sealVault(
						cryptoEngineId,
						packed,
						password,
						treePack ? { kind: 'tree' } : undefined
					);
					await writeOutputs([{ path: sealed.name, data: sealed.data }]);
				}
				onDone({ title: titleName });
				return;
			}

			const inner: PackedPath[] = [];
			for (const entry of entries) {
				if (entry.kind !== 'file') continue;
				const bytes = await (async () => {
					const blob = driver.readBlob
						? await driver.readBlob(entry.id)
						: await driver.download?.(entry.id);
					if (!blob) throw new Error('This connection cannot read the file');
					return new Uint8Array(await blob.arrayBuffer());
				})();
				inner.push(...(await expandPackedBytes(bytes, entry.name, password)));
			}
			if (!inner.length) throw new Error('Nothing to extract');
			if (dest === 'popup') {
				onDone({ inner, title: titleName });
				return;
			}
			await writeOutputs(inner);
			onDone({ title: titleName });
		} catch (e) {
			actionError = formatExplorerError(e);
			toast.error(actionError);
		} finally {
			busy = false;
		}
	}

	async function writeOutputs(files: PackedPath[]) {
		if (dest === 'memory') {
			const mem = createMemoryExplorerDriver(getMemoryVfs());
			await mem.ready();
			await writeEntriesToDriver(mem, null, files);
			return;
		}
		const parent = dest === 'same' ? (entries[0]?.parentId ?? null) : pickParent;
		await writeEntriesToDriver(driver, parent, files);
	}
</script>

<div
	class="modal-root"
	data-testid="fe-archive-dialog"
	data-kind={kind}
	role="dialog"
	aria-modal="true"
	aria-labelledby="fe-archive-title"
>
	<div class="scrim" onclick={onCancel} role="presentation"></div>
	<div class="card">
		<h2 id="fe-archive-title">{KIND_TITLE[kind]} {titleName}</h2>

		{#if kind === 'compress'}
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
					? ' · Multiple items pack as a container archive.'
					: ''}
			</p>
		{:else if kind === 'encrypt'}
			<div class="fields">
				<label>
					<span>Library</span>
					<select bind:value={cryptoEngineId} data-testid="fe-archive-engine">
						{#each cryptoEngines as engine (engine.id)}
							<option value={engine.id}>{engine.label}</option>
						{/each}
					</select>
				</label>
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
			</div>
			<p class="hint">
				{cryptoEngine.description} · {cryptoEngine.aead} · {cryptoEngine.kdf}{treePack
					? ' · Multiple items seal as a vault tree.'
					: ''}
			</p>
		{:else if kind === 'decompress'}
			<div class="fields">
				<label>
					<span>Library</span>
					<select bind:value={compressEngineId} data-testid="fe-archive-engine">
						{#each compressEngines as engine (engine.id)}
							<option value={engine.id}>{engine.label}</option>
						{/each}
					</select>
				</label>
			</div>
			<p class="hint">{compressEngine.description} · Format is detected from the file.</p>
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
			</div>
			<p class="hint">Unlocks a Scratch Pad vault (.spvault).</p>
		{/if}

		{#if engineStatus === 'loading'}
			<p class="hint">Loading engine…</p>
		{:else if engineStatus === 'error'}
			<p class="err" role="alert">{engineError}</p>
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
					Same folder
				</label>
				{#if canPickFolder}
					<label>
						<input type="radio" name="fe-archive-dest" value="folder" bind:group={dest} />
						Choose folder…
					</label>
				{/if}
				{#if !alreadyMemory}
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
				{#if isExtract}
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

		<div class="actions">
			<button type="button" class="ds-btn ds-btn--sm ds-btn--ghost" data-testid="fe-archive-cancel" onclick={onCancel}>
				Cancel
			</button>
			<button
				type="button"
				class="ds-btn ds-btn--sm ds-btn--primary"
				data-testid="fe-archive-run"
				disabled={!canRun}
				onclick={() => void run()}
			>
				{busy ? KIND_BUSY[kind] : dest === 'popup' ? 'Open' : KIND_TITLE[kind]}
			</button>
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
	.scrim {
		position: absolute;
		inset: 0;
		background: rgb(var(--scrim-rgb) / 0.55);
	}
	.card {
		position: relative;
		z-index: 1;
		width: min(420px, calc(100vw - 2rem));
		max-height: min(80vh, 560px);
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
	select,
	input[type='password'] {
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
