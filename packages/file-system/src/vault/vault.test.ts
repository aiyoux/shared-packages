import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import {
	closeCredentialsDbForTests as closeB2,
	getProfile as getB2,
	listStoredProfiles as listB2Stored,
	saveProfile as saveB2
} from '../b2/credentials.js';
import { HUB_B2_DB_NAME } from '../b2/types.js';
import {
	closeCredentialsDbForTests as closeRclone,
	getProfile as getRclone,
	listStoredProfiles as listRcloneStored,
	saveProfile as saveRclone
} from '../rclone/credentials.js';
import { HUB_RCLONE_DB_NAME } from '../rclone/types.js';
import { setVaultKdfCostForTests } from './crypto.js';
import {
	closeVaultDbForTests,
	disableVault,
	enableVault,
	isVaultEnabled,
	isVaultUnlocked,
	lockVault,
	unlockVault
} from './store.js';
import { HUB_VAULT_DB_NAME, VaultLockedError, VaultWrongPassphraseError } from './types.js';

/** Fast KDF for tests; production uses 600_000 (not exported from @shared-packages/crypto). */
const TEST_PBKDF2_ITERATIONS = 1_000;

const PASS = 'correct horse battery';

async function wipe(name: string) {
	await new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(name);
		req.onsuccess = req.onerror = req.onblocked = () => resolve();
	});
}

describe('connection vault', () => {
	beforeEach(async () => {
		setVaultKdfCostForTests(TEST_PBKDF2_ITERATIONS);
		await closeVaultDbForTests();
		await closeB2();
		await closeRclone();
		await wipe(HUB_VAULT_DB_NAME);
		await wipe(HUB_B2_DB_NAME);
		await wipe(HUB_RCLONE_DB_NAME);
	});

	afterEach(async () => {
		await closeVaultDbForTests();
		await closeB2();
		await closeRclone();
	});

	it('default is off; secrets stay plaintext', async () => {
		expect(await isVaultEnabled()).toBe(false);
		const saved = await saveB2({
			id: 'p1',
			name: 'Home',
			applicationKeyId: '003abc',
			applicationKey: 'secret-value',
			bucketName: 'bucket'
		});
		expect(saved.applicationKey).toBe('secret-value');
		const stored = (await listB2Stored())[0]!;
		expect(stored.applicationKey).toBe('secret-value');
		expect(stored.sealedApplicationKey).toBeUndefined();
	});

	it('enable wraps existing B2 and rclone secrets and wipes plaintext', async () => {
		await saveB2({
			id: 'b1',
			name: 'B',
			applicationKeyId: '003abc',
			applicationKey: 'b2-secret',
			bucketName: 'bucket'
		});
		await saveRclone({
			id: 'r1',
			name: 'R',
			baseUrl: 'http://127.0.0.1:7750',
			fs: 'remote:',
			rcUser: 'u',
			rcPass: 'rc-secret'
		});
		await enableVault(PASS);
		expect(await isVaultEnabled()).toBe(true);
		expect(isVaultUnlocked()).toBe(true);

		const b2 = (await listB2Stored())[0]!;
		expect(b2.applicationKey).toBe('');
		expect(b2.sealedApplicationKey?.ct).toBeTruthy();
		expect((await getB2('b1'))?.applicationKey).toBe('b2-secret');

		const rc = (await listRcloneStored())[0]!;
		expect(rc.rcPass).toBe('');
		expect(rc.sealedRcPass?.ct).toBeTruthy();
		expect((await getRclone('r1'))?.rcPass).toBe('rc-secret');
	});

	it('lock hides persisted secrets until unlock', async () => {
		await saveB2({
			id: 'b1',
			name: 'B',
			applicationKeyId: '003abc',
			applicationKey: 'b2-secret',
			bucketName: 'bucket'
		});
		await enableVault(PASS);
		await lockVault();
		expect(isVaultUnlocked()).toBe(false);
		expect((await getB2('b1'))?.applicationKey).toBe('');
		await expect(unlockVault('wrong-passphrase')).rejects.toBeInstanceOf(VaultWrongPassphraseError);
		await unlockVault(PASS);
		expect((await getB2('b1'))?.applicationKey).toBe('b2-secret');
	});

	it('disable restores plaintext', async () => {
		await saveB2({
			id: 'b1',
			name: 'B',
			applicationKeyId: '003abc',
			applicationKey: 'b2-secret',
			bucketName: 'bucket'
		});
		await enableVault(PASS);
		await disableVault();
		expect(await isVaultEnabled()).toBe(false);
		const stored = (await listB2Stored())[0]!;
		expect(stored.applicationKey).toBe('b2-secret');
		expect(stored.sealedApplicationKey).toBeUndefined();
	});

	it('disable while locked throws', async () => {
		await enableVault(PASS);
		await lockVault();
		await expect(disableVault()).rejects.toBeInstanceOf(VaultLockedError);
	});

	it('session-only never writes the secret to IDB, even with vault on', async () => {
		await enableVault(PASS);
		await saveB2({
			id: 'b1',
			name: 'B',
			applicationKeyId: '003abc',
			applicationKey: 'tab-secret',
			bucketName: 'bucket',
			persistSecret: false
		});
		const stored = (await listB2Stored())[0]!;
		expect(stored.applicationKey).toBe('');
		expect(stored.sealedApplicationKey).toBeUndefined();
		expect(stored.persistSecret).toBe(false);
		expect((await getB2('b1'))?.applicationKey).toBe('tab-secret');
		await lockVault();
		// Tab-only secret survives passphrase lock (never at rest).
		expect((await getB2('b1'))?.applicationKey).toBe('tab-secret');
	});
});
