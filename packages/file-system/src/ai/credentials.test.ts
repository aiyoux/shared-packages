/**
 * Hub AI credential store tests (fake-indexeddb).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
	closeCredentialsDbForTests,
	deleteProfile,
	getActiveProfileId,
	listProfiles,
	listStoredProfiles,
	redactProfile,
	revealApiKey,
	saveProfile,
	setActiveProfileId
} from './credentials.js';
import { HUB_AI_DB_NAME, normalizeAiBaseUrl, validateAiProfileInput } from './types.js';
import { DEFAULT_AI_BASE_URL } from './types.js';

async function wipeDb() {
	await closeCredentialsDbForTests();
	await new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(HUB_AI_DB_NAME);
		req.onsuccess = req.onerror = req.onblocked = () => resolve();
	});
}

const baseProfile = {
	id: 'ai-1',
	name: 'Local LLM',
	baseUrl: 'http://127.0.0.1:11434/v1',
	apiKey: 'sk-test',
	model: 'llava'
};

describe('AI credential store', () => {
	beforeEach(async () => {
		await wipeDb();
	});

	afterEach(async () => {
		await closeCredentialsDbForTests();
	});

	it('normalizes base URLs', () => {
		expect(normalizeAiBaseUrl('')).toBe(DEFAULT_AI_BASE_URL);
		expect(normalizeAiBaseUrl('https://x.io/v1/')).toBe('https://x.io/v1');
		expect(normalizeAiBaseUrl('https://x.io/v1/chat/completions')).toBe('https://x.io/v1');
		expect(normalizeAiBaseUrl(' https://x.io/v1/chat/completions/ ')).toBe('https://x.io/v1');
	});

	it('validates required fields', () => {
		expect(validateAiProfileInput({ name: '', baseUrl: 'https://x.io/v1', apiKey: 'k', model: 'm' })).toMatch(
			/Name/
		);
		expect(validateAiProfileInput({ name: 'n', baseUrl: 'ftp://x', apiKey: 'k', model: 'm' })).toMatch(
			/http or https/
		);
		expect(
			validateAiProfileInput({ name: 'n', baseUrl: 'https://u:p@x.io/v1', apiKey: 'k', model: 'm' })
		).toMatch(/credentials/);
		expect(validateAiProfileInput({ name: 'n', baseUrl: 'https://x.io/v1', apiKey: '', model: 'm' })).toMatch(
			/API key/
		);
		expect(validateAiProfileInput({ name: 'n', baseUrl: 'https://x.io/v1', apiKey: 'k', model: '' })).toMatch(
			/Model/
		);
		// requireApiKey: false (edit keeps existing key) allows a blank key.
		expect(
			validateAiProfileInput({ name: 'n', baseUrl: 'https://x.io/v1', apiKey: '', model: 'm', requireApiKey: false })
		).toBeNull();
	});

	it('saves, lists and round-trips a profile (vault off → plaintext IDB)', async () => {
		const saved = await saveProfile({ ...baseProfile });
		expect(saved.apiKey).toBe('sk-test');
		const rows = await listStoredProfiles();
		expect(rows).toHaveLength(1);
		expect(rows[0].apiKey).toBe('sk-test');
		const hydrated = await listProfiles();
		expect(hydrated[0].apiKey).toBe('sk-test');
		expect(hydrated[0].baseUrl).toBe('http://127.0.0.1:11434/v1');
	});

	it('strips a pasted /chat/completions suffix on save', async () => {
		const saved = await saveProfile({
			...baseProfile,
			baseUrl: 'http://127.0.0.1:11434/v1/chat/completions/'
		});
		expect(saved.baseUrl).toBe('http://127.0.0.1:11434/v1');
	});

	it('redacts the key', async () => {
		const saved = await saveProfile({ ...baseProfile });
		const redacted = redactProfile(saved);
		expect(redacted.apiKey).toBe('***');
		expect('sealedApiKey' in redacted).toBe(false);
		expect(redacted.model).toBe('llava');
	});

	it('edits keep the existing key when a blank key is passed', async () => {
		await saveProfile({ ...baseProfile });
		const edited = await saveProfile({ ...baseProfile, name: 'Renamed', apiKey: '' });
		expect(edited.name).toBe('Renamed');
		expect(edited.apiKey).toBe('sk-test');
	});

	it('resets the active profile on delete and clears session-only keys', async () => {
		await saveProfile({ ...baseProfile });
		await setActiveProfileId('ai-1');
		expect(await getActiveProfileId()).toBe('ai-1');
		await deleteProfile('ai-1');
		expect(await getActiveProfileId()).toBeNull();
		expect(await listProfiles()).toHaveLength(0);
	});

	it('sorts stored profiles newest-first', async () => {
		await saveProfile({ ...baseProfile });
		await saveProfile({ ...baseProfile, id: 'ai-2', name: 'Older' });
		const rows = await listStoredProfiles();
		expect(rows.map((r) => r.id)).toEqual(['ai-2', 'ai-1']);
	});
});