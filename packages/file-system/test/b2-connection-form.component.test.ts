/**
 * B2ConnectionForm: shared list → new/edit popup (jsdom + fake-indexeddb).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import 'fake-indexeddb/auto';
import B2ConnectionForm from '../src/b2/B2ConnectionForm.svelte';
import { closeCredentialsDbForTests, listProfiles } from '../src/b2/credentials.js';
import { HUB_B2_DB_NAME } from '../src/b2/types.js';

async function wipeDb() {
	await closeCredentialsDbForTests();
	await new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(HUB_B2_DB_NAME);
		req.onsuccess = req.onerror = req.onblocked = () => resolve();
	});
}

describe('B2ConnectionForm', () => {
	beforeEach(async () => {
		await wipeDb();
	});

	afterEach(async () => {
		await closeCredentialsDbForTests();
	});

	it('starts on the saved list; Add does not connect', async () => {
		const onConnected = vi.fn();
		render(B2ConnectionForm, { props: { onConnected } });
		await screen.findByTestId('b2-connection-form');
		expect(screen.getByTestId('b2-profile-new')).toBeTruthy();
		expect(screen.queryByTestId('b2-name')).toBeNull();
		expect(screen.queryByTestId('b2-save-connect')).toBeNull();

		await fireEvent.click(screen.getByTestId('b2-profile-new'));
		await fireEvent.input(screen.getByTestId('b2-name'), { target: { value: 'Photos' } });
		await fireEvent.input(screen.getByTestId('b2-key-id'), {
			target: { value: '003e2ekeyaaaaaaaaaaaaa' }
		});
		await fireEvent.input(screen.getByTestId('b2-key'), { target: { value: 'secret-key' } });
		await fireEvent.input(screen.getByTestId('b2-bucket'), { target: { value: 'photos-bucket' } });
		await fireEvent.click(screen.getByTestId('b2-save-only'));

		await vi.waitFor(async () => expect(await listProfiles()).toHaveLength(1));
		expect(onConnected).not.toHaveBeenCalled();
		await screen.findByText('Photos');
		await fireEvent.click(screen.getByTestId('b2-profile-select'));
		await vi.waitFor(() => expect(onConnected).toHaveBeenCalled());
	});
});
