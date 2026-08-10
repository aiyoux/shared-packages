/**
 * Hub rclone credential store tests (fake-indexeddb).
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
import {
	HUB_RCLONE_DB_NAME,
	validateProfileInput,
	normalizeRootPath
} from './types.js';

async function wipeDb() {
	await closeCredentialsDbForTests();
	await new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(HUB_RCLONE_DB_NAME);
		req.onsuccess = req.onerror = req.onblocked = () => resolve();
	});
}

describe('rclone credentials store', () => {
	beforeEach(async () => {
		await wipeDb();
	});

	afterEach(async () => {
		await closeCredentialsDbForTests();
	});

	it('validates required fields; allows any http(s) baseUrl', () => {
		expect(
			validateProfileInput({
				name: '',
				fs: 'home:',
				rcPass: 'x'
			})
		).toMatch(/Name/);
		expect(
			validateProfileInput({
				name: 'n',
				fs: '',
				rcPass: 'x'
			})
		).toMatch(/Remote|fs/i);
		// Tunnel / remote hosts are allowed (browser talks directly)
		expect(
			validateProfileInput({
				name: 'n',
				fs: 'home:',
				baseUrl: 'https://rclone.example.com',
				rcPass: 'x'
			})
		).toBeNull();
		expect(
			validateProfileInput({
				name: 'n',
				fs: 'home:',
				baseUrl: 'http://127.0.0.1:22',
				rcPass: 'x'
			})
		).toBeNull();
		expect(
			validateProfileInput({
				name: 'n',
				fs: 'home:',
				baseUrl: 'http://127.0.0.1:7750',
				rcPass: 'x'
			})
		).toBeNull();
		expect(
			validateProfileInput({
				name: 'n',
				fs: 'home:',
				baseUrl: 'http://user:pass@127.0.0.1:7750',
				rcPass: 'x'
			})
		).toMatch(/credentials/i);
	});

	it('normalizeRootPath rejects ..', () => {
		expect(normalizeRootPath('a/b')).toBe('a/b');
		expect(() => normalizeRootPath('a/../b')).toThrow();
	});

	it('saves, lists, loads, blank pass keeps secret, active, redact, delete', async () => {
		const saved = await saveProfile({
			id: 'p1',
			name: 'Local rcd',
			baseUrl: 'http://127.0.0.1:7750',
			fs: 'home:',
			rootPath: 'Code',
			rcUser: 'user',
			rcPass: 'secret-value'
		});
		expect(saved.v).toBe(1);
		expect(saved.rootPath).toBe('Code');
		expect(saved.rcPass).toBe('secret-value');

		const listed = await listProfiles();
		expect(listed).toHaveLength(1);

		// blank pass keeps prior
		const updated = await saveProfile({
			id: 'p1',
			name: 'Local rcd',
			baseUrl: 'http://127.0.0.1:7750',
			fs: 'home:',
			rootPath: 'Code',
			rcUser: 'user',
			rcPass: '',
			createdAt: saved.createdAt
		});
		expect(updated.rcPass).toBe('secret-value');

		await setActiveProfileId('p1');
		expect(await getActiveProfileId()).toBe('p1');

		const loaded = await getProfile('p1');
		const redacted = redactProfile(loaded!);
		expect(redacted.rcPass).toBe('***');
		expect(redacted.rcUser).toBe('user');

		await deleteProfile('p1');
		expect(await listProfiles()).toHaveLength(0);
		expect(await getActiveProfileId()).toBeNull();
	});
});
