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
		await fireEvent.click(screen.getByTestId('rclone-profile-new'));

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

	/**
	 * Non-loopback hosts are ALLOWED by design since "rclone RC client talks
	 * direct to baseUrl (no hub proxy)" — the browser opens the RC endpoint
	 * itself, so a tunnel or LAN address is legitimate (see the explicit
	 * "Any host is allowed" note in validateProfileInput). Loopback is still
	 * enforced for the *server-side* proxy path by `rcAllowlist`, which has its
	 * own tests; that is a different boundary.
	 *
	 * This test previously asserted the pre-change rule (reject non-loopback)
	 * and had been failing ever since.
	 */
	it('form.host: non-loopback baseUrl is accepted (direct-connect model)', async () => {
		render(RcloneConnectionForm, { props: {} });
		await screen.findByTestId('rclone-connection-form');
		await fireEvent.click(screen.getByTestId('rclone-profile-new'));

		await fireEvent.input(screen.getByTestId('rclone-name'), {
			target: { value: 'Tunnelled host' }
		});
		await fireEvent.input(screen.getByTestId('rclone-base-url'), {
			target: { value: 'https://rclone.example.com:7750' }
		});
		await fireEvent.input(screen.getByTestId('rclone-fs'), {
			target: { value: 'remote:' }
		});
		await fireEvent.input(screen.getByTestId('rclone-user'), {
			target: { value: 'user' }
		});
		await fireEvent.input(screen.getByTestId('rclone-pass'), {
			target: { value: 'secret' }
		});
		await fireEvent.click(screen.getByTestId('rclone-save-only'));

		await vi.waitFor(async () => expect(await listProfiles()).toHaveLength(1));
		const [saved] = await listProfiles();
		expect(saved.baseUrl).toBe('https://rclone.example.com:7750');
		expect(screen.queryByTestId('rclone-form-error')).toBeNull();
	});

	it('form.validation: credentials embedded in baseUrl are rejected', async () => {
		render(RcloneConnectionForm, { props: {} });
		await screen.findByTestId('rclone-connection-form');
		await fireEvent.click(screen.getByTestId('rclone-profile-new'));

		await fireEvent.input(screen.getByTestId('rclone-name'), {
			target: { value: 'Creds in URL' }
		});
		await fireEvent.input(screen.getByTestId('rclone-base-url'), {
			target: { value: 'http://user:pass@127.0.0.1:7750' }
		});
		await fireEvent.input(screen.getByTestId('rclone-fs'), {
			target: { value: 'remote:' }
		});
		await fireEvent.input(screen.getByTestId('rclone-pass'), {
			target: { value: 'secret' }
		});
		await fireEvent.click(screen.getByTestId('rclone-save-only'));

		const err = await screen.findByTestId('rclone-form-error');
		expect(err.textContent).toMatch(/credential/i);
		expect(await listProfiles()).toHaveLength(0);
	});

	it('defaults baseUrl to DEFAULT_RCLONE_BASE_URL', async () => {
		render(RcloneConnectionForm, { props: {} });
		await screen.findByTestId('rclone-connection-form');
		await fireEvent.click(screen.getByTestId('rclone-profile-new'));
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
		await screen.findByText('Home');

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
		// Save returns to the list — fields (and the secret) are gone
		expect(screen.queryByTestId('rclone-pass')).toBeNull();
		expect(screen.getByTestId('rclone-saved-profiles').textContent).toMatch(/Home renamed/);
	});

	it('opens on the saved list; New / Edit swap in fields with Add or Update', async () => {
		await saveProfile({
			id: 'prof-list',
			name: 'Home',
			baseUrl: DEFAULT_RCLONE_BASE_URL,
			fs: 'home:',
			rcUser: 'user',
			rcPass: 'secret'
		});
		render(RcloneConnectionForm, { props: {} });
		await screen.findByText('Home');
		expect(screen.queryByTestId('rclone-name')).toBeNull();
		expect(screen.queryByTestId('rclone-save-connect')).toBeNull();
		expect(screen.getByTestId('rclone-profile-new').textContent).toMatch(/New connection/i);

		await fireEvent.click(screen.getByTestId('rclone-profile-new'));
		expect(screen.getByTestId('rclone-name')).toBeTruthy();
		expect(screen.getByTestId('rclone-save-only').textContent).toMatch(/^Add$/);
		expect(screen.getByTestId('rclone-cancel')).toBeTruthy();

		await fireEvent.click(screen.getByTestId('rclone-cancel'));
		await screen.findByTestId('rclone-saved-profiles');
		expect(screen.queryByTestId('rclone-name')).toBeNull();

		await fireEvent.click(screen.getByTestId('rclone-profile-edit'));
		expect(screen.getByTestId('rclone-name')).toBeTruthy();
		expect(screen.getByTestId('rclone-save-only').textContent).toMatch(/^Update$/);
	});

	it('saves a valid loopback profile', async () => {
		const onConnected = vi.fn();
		render(RcloneConnectionForm, { props: { onConnected } });
		await screen.findByTestId('rclone-connection-form');
		await fireEvent.click(screen.getByTestId('rclone-profile-new'));

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
		await fireEvent.click(screen.getByTestId('rclone-save-only'));

		await vi.waitFor(async () => {
			const rows = await listProfiles();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.name).toBe('Local rcd');
			expect(rows[0]?.fs).toBe('remote:');
			expect(rows[0]?.rootPath).toBe('docs');
			expect(rows[0]?.baseUrl).toBe(DEFAULT_RCLONE_BASE_URL);
		});
		expect(onConnected).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByTestId('rclone-profile-select'));
		await vi.waitFor(() => expect(onConnected).toHaveBeenCalled());
		const connected = onConnected.mock.calls[0]?.[0];
		expect(connected?.rcPass).toBe('pass-not-logged');
	});
});
