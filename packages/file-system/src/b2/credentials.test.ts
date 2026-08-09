/**
 * Hub B2 credential store tests (fake-indexeddb).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
	closeCredentialsDbForTests,
	deleteProfile,
	getActiveProfileId,
	getProfile,
	listProfiles,
	redactProfile,
	saveProfile,
	setActiveProfileId
} from './credentials.js';
import { HUB_B2_DB_NAME, validateProfileInput } from './types.js';

async function wipeDb() {
	await closeCredentialsDbForTests();
	await new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(HUB_B2_DB_NAME);
		req.onsuccess = req.onerror = req.onblocked = () => resolve();
	});
}

describe('B2 credentials store', () => {
	beforeEach(async () => {
		await wipeDb();
	});

	afterEach(async () => {
		await closeCredentialsDbForTests();
	});

	it('validates required fields', () => {
		expect(
			validateProfileInput({
				name: '',
				applicationKeyId: 'k',
				applicationKey: 's',
				bucketName: 'b'
			})
		).toMatch(/Name/);
		expect(
			validateProfileInput({
				name: 'n',
				applicationKeyId: 'k',
				applicationKey: 's',
				bucketName: 'bad/name'
			})
		).toMatch(/Bucket/);
		expect(
			validateProfileInput({
				name: 'n',
				applicationKeyId: 'k',
				applicationKey: 's',
				bucketName: 'ok'
			})
		).toBeNull();
	});

	it('saves, lists, loads, sets active, deletes and clears active', async () => {
		const saved = await saveProfile({
			id: 'p1',
			name: 'Home',
			applicationKeyId: 'keyId',
			applicationKey: 'secret-value',
			bucketName: 'my-bucket',
			namePrefix: 'team'
		});
		expect(saved.v).toBe(1);
		expect(saved.namePrefix).toBe('team/');
		expect(saved.applicationKey).toBe('secret-value');

		const listed = await listProfiles();
		expect(listed).toHaveLength(1);
		expect(listed[0]!.id).toBe('p1');

		const loaded = await getProfile('p1');
		expect(loaded?.bucketName).toBe('my-bucket');

		await setActiveProfileId('p1');
		expect(await getActiveProfileId()).toBe('p1');

		const redacted = redactProfile(loaded!);
		expect(redacted.applicationKey).toBe('***');
		expect(redacted.applicationKeyId).toBe('keyId');

		await deleteProfile('p1');
		expect(await listProfiles()).toHaveLength(0);
		expect(await getActiveProfileId()).toBeNull();
	});
});
