<script lang="ts">
	import { HUB_VAULT_CHANNEL, subscribeTabChannel } from '../crossTab.js';
	import { formatExplorerError } from '../ui/explorerError.js';
	import {
		disableVault,
		enableVault,
		getVaultStatus,
		lockVault,
		unlockVault,
		type VaultStatus
	} from './store.js';

	let status = $state<VaultStatus>({ enabled: false, unlocked: false });
	let passphrase = $state('');
	let passphrase2 = $state('');
	let error = $state('');
	let busy = $state(false);
	let confirmDisable = $state(false);

	async function reload() {
		status = await getVaultStatus();
	}

	$effect(() => {
		void reload();
		return subscribeTabChannel(HUB_VAULT_CHANNEL, () => {
			void reload();
		});
	});

	async function run(fn: () => Promise<void>) {
		error = '';
		busy = true;
		try {
			await fn();
			passphrase = '';
			passphrase2 = '';
			confirmDisable = false;
			await reload();
		} catch (e) {
			error = formatExplorerError(e);
		} finally {
			busy = false;
		}
	}
</script>

<section class="vault" data-testid="connection-vault">
	<h4>Lock saved keys</h4>
	<p class="hint">
		Optional. A passphrase encrypts Backblaze and rclone secrets in this browser. Default is
		unencrypted IndexedDB. Unlock is per tab; locking drops live remote sessions.
		If you forget the passphrase, re-enter each key.
	</p>

	{#if error}
		<div class="err" data-testid="vault-error" role="alert">{error}</div>
	{/if}

	{#if !status.enabled}
		<label>
			New passphrase
			<input
				data-testid="vault-pass"
				type="password"
				autocomplete="new-password"
				bind:value={passphrase}
			/>
		</label>
		<label>
			Confirm passphrase
			<input
				data-testid="vault-pass-confirm"
				type="password"
				autocomplete="new-password"
				bind:value={passphrase2}
			/>
		</label>
		<button
			type="button"
			data-testid="vault-enable"
			disabled={busy || passphrase.length < 8 || passphrase !== passphrase2}
			onclick={() => run(() => enableVault(passphrase))}
		>
			{busy ? 'Encrypting…' : 'Encrypt saved keys'}
		</button>
	{:else if !status.unlocked}
		<p class="status" data-testid="vault-locked-banner">Vault locked — saved keys are encrypted.</p>
		<label>
			Passphrase
			<input
				data-testid="vault-unlock-pass"
				type="password"
				autocomplete="current-password"
				bind:value={passphrase}
			/>
		</label>
		<button
			type="button"
			data-testid="vault-unlock"
			disabled={busy || !passphrase}
			onclick={() => run(() => unlockVault(passphrase))}
		>
			{busy ? 'Unlocking…' : 'Unlock'}
		</button>
	{:else}
		<p class="status" data-testid="vault-unlocked-banner">Vault unlocked in this tab.</p>
		<div class="actions">
			<button type="button" data-testid="vault-lock" disabled={busy} onclick={() => run(() => lockVault())}>
				Lock
			</button>
			{#if !confirmDisable}
				<button
					type="button"
					class="ghost"
					data-testid="vault-disable-ask"
					disabled={busy}
					onclick={() => (confirmDisable = true)}
				>
					Turn off encryption
				</button>
			{:else}
				<button
					type="button"
					class="danger"
					data-testid="vault-disable"
					disabled={busy}
					onclick={() => run(() => disableVault())}
				>
					Decrypt and store keys in plaintext
				</button>
				<button type="button" class="ghost" disabled={busy} onclick={() => (confirmDisable = false)}>
					Cancel
				</button>
			{/if}
		</div>
	{/if}
</section>

<style>
	.vault {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.65rem 0.75rem;
		border: 1px solid var(--line-hairline);
		border-radius: var(--radius-md);
		background: var(--surface-2);
	}
	h4 {
		margin: 0;
		font-size: 0.9rem;
	}
	.hint,
	.status {
		margin: 0;
		font-size: 0.8rem;
		color: var(--text-muted);
		line-height: 1.4;
	}
	.err {
		padding: 0.4rem 0.55rem;
		background: rgb(var(--danger-rgb) / 0.16);
		color: var(--cat-red-soft);
		font-size: 0.85rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.85rem;
	}
	input {
		padding: 0.4rem 0.55rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--line-hairline);
		background: var(--surface-1, var(--surface-2));
		color: inherit;
		font: inherit;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	button {
		padding: 0.35rem 0.7rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--line-strong);
		background: var(--surface-2);
		color: var(--text-primary);
		cursor: pointer;
		font-size: 0.85rem;
		width: fit-content;
	}
	button:disabled {
		opacity: 0.6;
	}
	button.danger {
		border-color: var(--danger);
		color: var(--cat-red-soft);
		background: rgb(var(--danger-rgb) / 0.12);
	}
	button.ghost {
		background: transparent;
	}
</style>
