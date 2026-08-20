<script lang="ts">
	/**
	 * Compress or encrypt a FileExplorer row using the same engines as the
	 * hub Compress / Hash & Vault tools (`@shared-packages/compress`, `crypto`).
	 */
	import '@shared-packages/design-system/button.css';
	import {
		CODEC_LABEL,
		DEFAULT_ENGINE as DEFAULT_COMPRESS_ENGINE,
		defaultCodecFor,
		listEngines as listCompressEngines,
		loadEngine as loadCompressEngine,
		packFiles,
		type Codec,
		type EngineId as CompressEngineId
	} from '@shared-packages/compress';
	import {
		DEFAULT_ENGINE as DEFAULT_CRYPTO_ENGINE,
		listEngines as listCryptoEngines,
		loadEngine as loadCryptoEngine,
		sealVault,
		type EngineId as CryptoEngineId
	} from '@shared-packages/crypto';
	import { getMemoryVfs } from '../memoryVfs.js';
	import { createMemoryExplorerDriver } from './memoryExplorerDriver.js';
	import type { ExplorerDriver, ExplorerEntry } from './explorerDriver.js';

	type Kind = 'compress' | 'encrypt';
	type Dest = 'same' | 'folder' | 'memory';

	const COMPRESS_STORAGE = 'scratchpad-compress-engine';
	const CRYPTO_STORAGE = 'scratchpad-crypto-engine';

	let {
		kind,
		entry,
		driver,
		onDone,
		onCancel
	}: {
		kind: Kind;
		entry: ExplorerEntry;
		driver: ExplorerDriver;
		onDone: () => void;
		onCancel: () => void;
	} = $props();

	const compressEngines = listCompressEngines();
	const cryptoEngines = listCryptoEngines();

	let dest = $state<Dest>('same');
	let compressEngineId = $state<CompressEngineId>(readStored(COMPRESS_STORAGE, DEFAULT_COMPRESS_ENGINE));
	let codec = $state<Codec>(defaultCodecFor(readStored(COMPRESS_STORAGE, DEFAULT_COMPRESS_ENGINE)));
	let cryptoEngineId = $state<CryptoEngineId>(readStoredCrypto());
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
	const availableCodecs = $derived(compressEngine.codecs);
	const canPickFolder = $derived(driver.capabilities.supportsMkdir);
	const alreadyMemory = $derived(driver.id === 'memory');
	const canWriteHere = $derived(Boolean(driver.writeFile || driver.upload));

	$effect(() => {
		if (dest === 'same' && !canWriteHere && !alreadyMemory) dest = 'memory';
	});

	$effect(() => {
		if (!availableCodecs.includes(codec)) codec = defaultCodecFor(compressEngineId);
	});

	$effect(() => {
		const id = kind === 'compress' ? compressEngineId : cryptoEngineId;
		let cancelled = false;
		engineStatus = 'loading';
		engineError = '';
		const load = kind === 'compress' ? loadCompressEngine(id as CompressEngineId) : loadCryptoEngine(id as CryptoEngineId);
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
			localStorage.setItem(kind === 'compress' ? COMPRESS_STORAGE : CRYPTO_STORAGE, id);
		} catch {
			/* ignore */
		}
		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		if (pickParent === null) pickParent = entry.parentId;
	});

	$effect(() => {
		if (dest !== 'folder') return;
		void loadPick(pickParent);
	});

	function readStored(key: string, fallback: CompressEngineId): CompressEngineId {
		try {
			const v = localStorage.getItem(key);
			if (v === 'fflate' || v === 'zipkit' || v === 'addmaple') return v;
		} catch {
			/* ignore */
		}
		return fallback;
	}

	function readStoredCrypto(): CryptoEngineId {
		try {
			const v = localStorage.getItem(CRYPTO_STORAGE);
			if (v === 'webcrypto' || v === 'libsodium') return v;
		} catch {
			/* ignore */
		}
		return DEFAULT_CRYPTO_ENGINE;
	}

	async function loadPick(parentId: string | null) {
		pickBusy = true;
		try {
			const listed = await driver.list({ parentId });
			pickFolders = listed.entries.filter((e) => e.kind === 'folder');
			pickCrumbs = parentId ? await driver.getPath(parentId) : [];
		} catch (e) {
			actionError = e instanceof Error ? e.message : String(e);
		} finally {
			pickBusy = false;
		}
	}

	async function readSource(): Promise<Uint8Array> {
		const blob = driver.readBlob
			? await driver.readBlob(entry.id)
			: await driver.download?.(entry.id);
		if (!blob) throw new Error('This connection cannot read the file');
		return new Uint8Array(await blob.arrayBuffer());
	}

	async function writeDest(name: string, data: Uint8Array, type: string) {
		const file = new File([data], name, { type });
		if (dest === 'memory') {
			const mem = createMemoryExplorerDriver(getMemoryVfs());
			await mem.ready();
			await mem.writeFile!(null, file);
			return;
		}
		const parent = dest === 'same' ? entry.parentId : pickParent;
		const put = driver.writeFile ?? driver.upload;
		if (!put) throw new Error('This location cannot receive files');
		await put(parent, file);
	}

	const canRun = $derived(
		engineStatus === 'ready' &&
			!busy &&
			(dest !== 'same' || canWriteHere) &&
			(dest !== 'folder' || canPickFolder) &&
			(kind === 'compress' || (password.length > 0 && password === password2))
	);

	async function run() {
		if (!canRun) return;
		busy = true;
		actionError = '';
		try {
			const bytes = await readSource();
			if (kind === 'compress') {
				const packed = await packFiles(compressEngineId, [{ name: entry.name, data: bytes }], codec);
				const out = packed[0]!;
				await writeDest(out.name, out.data, 'application/octet-stream');
			} else {
				const sealed = await sealVault(cryptoEngineId, [{ path: entry.name, data: bytes }], password);
				await writeDest(sealed.name, sealed.data, 'application/octet-stream');
			}
			onDone();
		} catch (e) {
			actionError = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
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
		<h2 id="fe-archive-title">{kind === 'compress' ? 'Compress' : 'Encrypt'} {entry.name}</h2>

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
					<select bind:value={codec} data-testid="fe-archive-codec">
						{#each availableCodecs as c (c)}
							<option value={c}>{CODEC_LABEL[c]}</option>
						{/each}
					</select>
				</label>
			</div>
			<p class="hint">{compressEngine.description}</p>
		{:else}
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
			<p class="hint">{cryptoEngine.description} · {cryptoEngine.aead} · {cryptoEngine.kdf}</p>
		{/if}

		{#if engineStatus === 'loading'}
			<p class="hint">Loading engine…</p>
		{:else if engineStatus === 'error'}
			<p class="err" role="alert">{engineError}</p>
		{/if}

		<fieldset class="dest">
			<legend>Save to</legend>
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
					<input type="radio" name="fe-archive-dest" value="memory" bind:group={dest} data-testid="fe-archive-dest-memory" />
					In-memory storage
				</label>
			{/if}
		</fieldset>

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
				{busy ? (kind === 'compress' ? 'Compressing…' : 'Encrypting…') : kind === 'compress' ? 'Compress' : 'Encrypt'}
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
