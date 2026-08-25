/**
 * MonitorConnectionForm: shared list → new/edit popup (jsdom + fake-indexeddb).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import 'fake-indexeddb/auto';
import MonitorConnectionForm from '../src/monitor/MonitorConnectionForm.svelte';
import {
	closeCredentialsDbForTests,
	listProfiles,
	saveProfile
} from '../src/monitor/credentials.js';
import { DEFAULT_MONITOR_BASE_URL, HUB_MONITOR_DB_NAME } from '../src/monitor/types.js';

async function wipeDb() {
	await closeCredentialsDbForTests();
	await new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(HUB_MONITOR_DB_NAME);
		req.onsuccess = req.onerror = req.onblocked = () => resolve();
	});
}

describe('MonitorConnectionForm', () => {
	beforeEach(async () => {
		await wipeDb();
	});

	afterEach(async () => {
		await closeCredentialsDbForTests();
	});

	it('starts on the saved list; Add does not connect', async () => {
		const onConnected = vi.fn();
		render(MonitorConnectionForm, { props: { onConnected } });
		await screen.findByTestId('monitor-connection-form');
		expect(screen.getByTestId('monitor-profile-new')).toBeTruthy();
		expect(screen.queryByTestId('monitor-name')).toBeNull();
		expect(screen.queryByTestId('monitor-save-connect')).toBeNull();

		await fireEvent.click(screen.getByTestId('monitor-profile-new'));
		await fireEvent.input(screen.getByTestId('monitor-name'), { target: { value: 'Home' } });
		await fireEvent.input(screen.getByTestId('monitor-base-url'), {
			target: { value: DEFAULT_MONITOR_BASE_URL }
		});
		await fireEvent.input(screen.getByTestId('monitor-root-path'), { target: { value: '/tmp' } });
		await fireEvent.click(screen.getByTestId('monitor-save-only'));

		await vi.waitFor(async () => expect(await listProfiles()).toHaveLength(1));
		expect(onConnected).not.toHaveBeenCalled();
		await screen.findByText('Home');
		await fireEvent.click(screen.getByTestId('monitor-connect-profile'));
		await vi.waitFor(() => expect(onConnected).toHaveBeenCalled());
	});

	it('Edit swaps to fields with Update; Cancel returns to the list', async () => {
		await saveProfile({
			id: 'm1',
			name: 'Local',
			baseUrl: DEFAULT_MONITOR_BASE_URL,
			rootPath: '/tmp'
		});
		render(MonitorConnectionForm, { props: {} });
		await screen.findByText('Local');
		await fireEvent.click(screen.getByTestId('monitor-profile-edit'));
		expect(screen.getByTestId('monitor-save-only').textContent).toMatch(/^Update$/);
		await fireEvent.input(screen.getByTestId('monitor-name'), { target: { value: 'Renamed' } });
		await fireEvent.click(screen.getByTestId('monitor-cancel'));
		await screen.findByTestId('monitor-saved-profiles');
		expect(screen.queryByTestId('monitor-name')).toBeNull();
		expect((await listProfiles())[0]?.name).toBe('Local');
	});
});
