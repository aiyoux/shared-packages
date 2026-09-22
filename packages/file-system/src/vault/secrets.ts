/**
 * Read/write a profile secret against plaintext IDB, sealed IDB, or the tab session.
 */
import { unwrapSecret, wrapSecret } from './crypto.js';
import { clearSessionSecret, getSessionSecret, setSessionSecret } from './session.js';
import { isVaultEnabled } from './store.js';
import { isVaultUnlocked } from './session.js';
import {
	SecretUnavailableError,
	VaultLockedError,
	type SealedSecret,
	type SecretKind
} from './types.js';

export type StoredSecret = {
	persistSecret: boolean;
	plaintext: string;
	sealed?: SealedSecret;
};

export type MaterializedSecret = {
	persistSecret: boolean;
	idbPlaintext: string;
	sealed?: SealedSecret;
	revealed: string;
};

export async function readSecret(
	kind: SecretKind,
	id: string,
	stored: StoredSecret
): Promise<string> {
	if (!stored.persistSecret) return getSessionSecret(kind, id);
	if (stored.sealed) {
		if (!isVaultUnlocked()) return '';
		try {
			return await unwrapSecret(stored.sealed, `${kind}:${id}`);
		} catch {
			return '';
		}
	}
	return stored.plaintext;
}

export async function revealStoredSecret(
	kind: SecretKind,
	id: string,
	stored: StoredSecret
): Promise<string> {
	const secret = await readSecret(kind, id, stored);
	if (secret) return secret;
	if (stored.sealed && (await isVaultEnabled()) && !isVaultUnlocked()) {
		throw new VaultLockedError();
	}
	if (!stored.persistSecret) throw new SecretUnavailableError();
	throw new SecretUnavailableError('No application key is stored for this connection.');
}

/**
 * Decide how to persist an incoming (or blank-keep) secret.
 *
 * Blank incoming + existing row keeps the previous storage as-is, including
 * when the vault is locked (name/bucket edits must not require unlock).
 */
export async function materializeForWrite(
	kind: SecretKind,
	id: string,
	incoming: string,
	persistSecretInput: boolean | undefined,
	existing: StoredSecret | undefined
): Promise<MaterializedSecret> {
	const incomingTrim = incoming.trim();
	const persistSecret = persistSecretInput ?? existing?.persistSecret ?? true;

	if (!incomingTrim && existing) {
		const persistUnchanged = persistSecret === (existing.persistSecret ?? true);
		if (persistUnchanged) {
			if (existing.sealed && !isVaultUnlocked()) {
				return {
					persistSecret,
					idbPlaintext: existing.plaintext,
					sealed: existing.sealed,
					revealed: ''
				};
			}
			const revealed = await readSecret(kind, id, existing);
			if (!persistSecret) {
				if (revealed) setSessionSecret(kind, id, revealed);
				return { persistSecret: false, idbPlaintext: '', sealed: undefined, revealed };
			}
			if (existing.sealed && isVaultUnlocked() && (await isVaultEnabled())) {
				return {
					persistSecret: true,
					idbPlaintext: '',
					sealed: existing.sealed,
					revealed
				};
			}
			if (revealed && (await isVaultEnabled())) {
				if (!isVaultUnlocked()) throw new VaultLockedError();
				const sealed = await wrapSecret(revealed, `${kind}:${id}`);
				clearSessionSecret(kind, id);
				return { persistSecret: true, idbPlaintext: '', sealed, revealed };
			}
			if (revealed) {
				clearSessionSecret(kind, id);
				return { persistSecret: true, idbPlaintext: revealed, sealed: undefined, revealed };
			}
		}
	}

	let revealed = incomingTrim;
	if (!revealed && existing) revealed = await readSecret(kind, id, existing);
	if (!revealed) {
		throw new SecretUnavailableError(
			kind === 'b2' ? 'Application key is required' : 'RC password is required'
		);
	}

	if (!persistSecret) {
		setSessionSecret(kind, id, revealed);
		return { persistSecret: false, idbPlaintext: '', sealed: undefined, revealed };
	}

	clearSessionSecret(kind, id);
	if (await isVaultEnabled()) {
		if (!isVaultUnlocked()) throw new VaultLockedError();
		const sealed = await wrapSecret(revealed, `${kind}:${id}`);
		return { persistSecret: true, idbPlaintext: '', sealed, revealed };
	}
	return { persistSecret: true, idbPlaintext: revealed, sealed: undefined, revealed };
}
