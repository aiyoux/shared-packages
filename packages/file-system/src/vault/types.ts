/**
 * Shared connection-secret vault (B2 application keys + rclone RC passwords).
 *
 * Opt-in. Default remains plaintext IndexedDB (v1). When enabled, secret fields
 * are AES-GCM wrapped with a PBKDF2 key derived from a user passphrase and are
 * never written back as plaintext. Unlock is per tab; lock drops the wrapping
 * key from memory.
 */

export const HUB_VAULT_DB_NAME = 'HubVault';
export const HUB_VAULT_STORE = 'meta';
export const HUB_VAULT_META_KEY = 'state';
export { HUB_VAULT_CHANNEL } from '../crossTab.js';

export type SecretKind = 'b2' | 'rclone';

/** AES-GCM blob stored on a profile in place of the plaintext secret. */
export type SealedSecret = {
	v: 1;
	iv: string;
	ct: string;
};

export type VaultMetaV1 = {
	v: 1;
	enabled: true;
	saltB64: string;
	verifierIvB64: string;
	verifierCtB64: string;
	kdfCost: number;
};

export class VaultLockedError extends Error {
	readonly code = 'VAULT_LOCKED';
	constructor(message = 'Unlock the connection vault to use saved keys.') {
		super(message);
		this.name = 'VaultLockedError';
	}
}

export class VaultWrongPassphraseError extends Error {
	readonly code = 'VAULT_WRONG_PASSPHRASE';
	constructor(message = 'That passphrase does not unlock the connection vault.') {
		super(message);
		this.name = 'VaultWrongPassphraseError';
	}
}

export class SecretUnavailableError extends Error {
	readonly code = 'SECRET_UNAVAILABLE';
	constructor(message = 'This key was not saved to disk. Re-enter it to connect.') {
		super(message);
		this.name = 'SecretUnavailableError';
	}
}

export function isVaultLockedError(e: unknown): e is VaultLockedError {
	return (
		e instanceof VaultLockedError ||
		(!!e && typeof e === 'object' && (e as { code?: string }).code === 'VAULT_LOCKED')
	);
}

export function isSecretUnavailableError(e: unknown): e is SecretUnavailableError {
	return (
		e instanceof SecretUnavailableError ||
		(!!e && typeof e === 'object' && (e as { code?: string }).code === 'SECRET_UNAVAILABLE')
	);
}
