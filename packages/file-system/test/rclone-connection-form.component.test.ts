/**
 * RcloneConnectionForm component tests (jsdom + fake-indexeddb).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import 'fake-indexeddb/auto';
import RcloneConnectionForm from '../src/rclone/RcloneConnectionForm.svelte';
import {
	closeCredentialsDbForTests,
	getProfile,
	listProfiles,
	saveProfile
} from '../src/rclone/credentials.js';
import { DEFAULT_RCLONE_BASE_URL, HUB_RCLONE_DB_NAME } from '../src/rclone/types.js';

async function wipeDb() {
	await closeCredentialsDbForTests();
	await new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(HUB_RCLONE_DB_NAME);
		req.onsuccess = req.onerror = req.onblocked = () => resolve();
	});
}

describe('RcloneConnectionForm', () => {
	beforeEach(async () => {
		await wipeDb();
	});

	afterEach(async () => {
		await closeCredentialsDbForTests();
	});

	it('form.required: empty name/fs → form error; no save', async () => {
		render(RcloneConnectionForm, { props: {} });
		await screen.findByTestId('rclone-connection-form');

		const name = screen.getByTestId('rclone-name') as HTMLInputElement;
		const fs = screen.getByTestId('rclone-fs') as HTMLInputElement;
		const pass = screen.getByTestId('rclone-pass') as HTMLInputElement;

		await fireEvent.input(name, { target: { value: '' } });
		await fireEvent.input(fs, { target: { value: '' } });
		await fireEvent.input(pass, { target: { value: 'secret' } });
		await fireEvent.click(screen.getByTestId('rclone-save-only'));

		const err = await screen.findByTestId('rclone-form-error');
		expect(err.textContent).toMatch(/name|required/i);
		expect(await listProfiles()).toHaveLength(0);
	});

	it('form.loopback: non-loopback baseUrl rejected', async () => {
		render(RcloneConnectionForm, { props: {} });
		await screen.findByTestId('rclone-connection-form');

		await fireEvent.input(screen.getByTestId('rclone-name'), {
			target: { value: 'Bad host' }
		});
		await fireEvent.input(screen.getByTestId('rclone-base-url'), {
			target: { value: 'http://example.com:7750' }
		});
		await fireEvent.input(screen.getByTestId('rclone-fs'), {
			target: { value: 'remote:' }
		});
		await fireEvent.input(screen.getByTestId('rclone-pass'), {
			target: { value: 'secret' }
		});
		await fireEvent.click(screen.getByTestId('rclone-save-only'));

		const err = await screen.findByTestId('rclone-form-error');
		expect(err.textContent).toMatch(/loopback/i);
		expect(await listProfiles()).toHaveLength(0);
	});

	it('defaults baseUrl to DEFAULT_RCLONE_BASE_URL', async () => {
		render(RcloneConnectionForm, { props: {} });
		await screen.findByTestId('rclone-connection-form');
		const base = screen.getByTestId('rclone-base-url') as HTMLInputElement;
		expect(base.value).toBe(DEFAULT_RCLONE_BASE_URL);
	});

	it('form.blankSecret + neverDisplayPass: edit leaves pass blank; blank keeps prior', async () => {
		const saved = await saveProfile({
			id: 'prof-1',
			name: 'Home',
			baseUrl: DEFAULT_RCLONE_BASE_URL,
			fs: 'home:',
			rcUser: 'user',
			rcPass: 'original-secret'
		});

		render(RcloneConnectionForm, { props: {} });
		await screen.findByTestId('rclone-saved-profiles');

		await fireEvent.click(screen.getByTestId('rclone-profile-edit'));
		const passInput = screen.getByTestId('rclone-pass') as HTMLInputElement;
		// Never put stored secret into the input value
		expect(passInput.value).toBe('');
		expect(passInput.value).not.toContain('original');
		expect(passInput.value).not.toContain('secret');

		// Change display name only; leave pass blank
		await fireEvent.input(screen.getByTestId('rclone-name'), {
			target: { value: 'Home renamed' }
		});
		await fireEvent.click(screen.getByTestId('rclone-save-only'));

		await vi.waitFor(async () => {
			const rows = await listProfiles();
			expect(rows.some((r) => r.name === 'Home renamed')).toBe(true);
		});

		const updated = await getProfile(saved.id);
		expect(updated?.rcPass).toBe('original-secret');
		// Input still must not display the secret after save
		expect((screen.getByTestId('rclone-pass') as HTMLInputElement).value).toBe('');
	});

	it('saves a valid loopback profile', async () => {
		const onConnected = vi.fn();
		render(RcloneConnectionForm, { props: { onConnected } });
		await screen.findByTestId('rclone-connection-form');

		await fireEvent.input(screen.getByTestId('rclone-name'), {
			target: { value: 'Local rcd' }
		});
		await fireEvent.input(screen.getByTestId('rclone-fs'), {
			target: { value: 'remote:' }
		});
		await fireEvent.input(screen.getByTestId('rclone-user'), {
			target: { value: 'rc' }
		});
		await fireEvent.input(screen.getByTestId('rclone-pass'), {
			target: { value: 'pass-not-logged' }
		});
		await fireEvent.input(screen.getByTestId('rclone-root'), {
			target: { value: 'docs' }
		});
		await fireEvent.click(screen.getByTestId('rclone-save-connect'));

		await vi.waitFor(async () => {
			const rows = await listProfiles();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.name).toBe('Local rcd');
			expect(rows[0]?.fs).toBe('remote:');
			expect(rows[0]?.rootPath).toBe('docs');
			expect(rows[0]?.baseUrl).toBe(DEFAULT_RCLONE_BASE_URL);
		});
		expect(onConnected).toHaveBeenCalled();
		// Ensure we never assert/log the raw secret in test output beyond IDB round-trip
		const connected = onConnected.mock.calls[0]?.[0];
		expect(connected?.rcPass).toBe('pass-not-logged');
	});
});
