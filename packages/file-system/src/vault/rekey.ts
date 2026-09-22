/**
 * Re-seal / unseal B2 + rclone persisted secrets when the vault is toggled.
 * Imported dynamically from store.ts to avoid a credentials ↔ vault cycle.
 */
import {
	listStoredProfiles as listB2Stored,
	rewriteStoredSecret as rewriteB2Secret
} from '../b2/credentials.js';
import {
	listStoredProfiles as listRcloneStored,
	rewriteStoredSecret as rewriteRcloneSecret
} from '../rclone/credentials.js';
import { evictAllB2Drivers } from '../b2/b2DriverCache.js';
import { evictAllRcloneDrivers } from '../rclone/rcloneDriverCache.js';
import { wrapSecret, unwrapSecret } from './crypto.js';
import { isVaultUnlocked } from './session.js';
import { VaultLockedError } from './types.js';

export async function resealPersistedSecrets(): Promise<void> {
	if (!isVaultUnlocked()) throw new VaultLockedError();
	for (const p of await listB2Stored()) {
		if (p.persistSecret === false) continue;
		const plain = p.applicationKey;
		if (!plain && !p.sealedApplicationKey) continue;
		const secret = plain || (p.sealedApplicationKey
			? await unwrapSecret(p.sealedApplicationKey, `b2:${p.id}`)
			: '');
		if (!secret) continue;
		const sealed = await wrapSecret(secret, `b2:${p.id}`);
		await rewriteB2Secret(p.id, { persistSecret: true, plaintext: '', sealed });
	}
	for (const p of await listRcloneStored()) {
		if (p.persistSecret === false) continue;
		const plain = p.rcPass;
		if (!plain && !p.sealedRcPass) continue;
		const secret = plain || (p.sealedRcPass ? await unwrapSecret(p.sealedRcPass, `rclone:${p.id}`) : '');
		if (!secret) continue;
		const sealed = await wrapSecret(secret, `rclone:${p.id}`);
		await rewriteRcloneSecret(p.id, { persistSecret: true, plaintext: '', sealed });
	}
}

export async function unsealPersistedSecrets(): Promise<void> {
	if (!isVaultUnlocked()) throw new VaultLockedError();
	for (const p of await listB2Stored()) {
		if (p.persistSecret === false) continue;
		if (!p.sealedApplicationKey) continue;
		const secret = await unwrapSecret(p.sealedApplicationKey, `b2:${p.id}`);
		await rewriteB2Secret(p.id, { persistSecret: true, plaintext: secret, sealed: undefined });
	}
	for (const p of await listRcloneStored()) {
		if (p.persistSecret === false) continue;
		if (!p.sealedRcPass) continue;
		const secret = await unwrapSecret(p.sealedRcPass, `rclone:${p.id}`);
		await rewriteRcloneSecret(p.id, { persistSecret: true, plaintext: secret, sealed: undefined });
	}
}

export function evictRemoteSessions(): void {
	evictAllB2Drivers();
	evictAllRcloneDrivers();
}
