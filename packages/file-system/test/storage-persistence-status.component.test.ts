/**
 * Click-popup for the origin storage pill.
 * Run: npm run test:component -- test/storage-persistence-status.component.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import StoragePersistenceStatus from '../src/ui/StoragePersistenceStatus.svelte';

function stubStorage(persisted: boolean, persist: () => Promise<boolean> = async () => true) {
	Object.defineProperty(navigator, 'storage', {
		configurable: true,
		value: {
			persisted: async () => persisted,
			persist,
			estimate: async () => ({ usage: 2048, quota: 8192 })
		}
	});
}

describe('StoragePersistenceStatus', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		Reflect.deleteProperty(navigator, 'storage');
	});

	it('opens a red popup with a permission button when storage is not persistent', async () => {
		stubStorage(false);
		render(StoragePersistenceStatus, { props: { pollMs: 0 } });
		const pill = await screen.findByTestId('fe-storage-persist');
		await vi.waitFor(() => expect(pill.getAttribute('data-status')).toBe('best-effort'));
		expect(screen.queryByTestId('fe-storage-persist-request')).toBeNull();

		await fireEvent.click(pill);
		const popup = screen.getByTestId('fe-storage-persist-popup');
		expect(popup.getAttribute('data-status')).toBe('best-effort');
		expect(popup.classList.contains('best-effort')).toBe(true);
		expect(screen.getByTestId('fe-storage-persist-explain').textContent).toMatch(/not agreed to keep/i);
		expect(screen.getByTestId('fe-storage-persist-request').textContent).toMatch(/Request permission/);
	});

	it('opens a green popup and hides the permission button when storage is persistent', async () => {
		stubStorage(true);
		render(StoragePersistenceStatus, { props: { pollMs: 0 } });
		const pill = await screen.findByTestId('fe-storage-persist');
		await vi.waitFor(() => expect(pill.getAttribute('data-status')).toBe('persistent'));

		await fireEvent.click(pill);
		const popup = screen.getByTestId('fe-storage-persist-popup');
		expect(popup.classList.contains('persistent')).toBe(true);
		expect(screen.getByTestId('fe-storage-persist-explain').textContent).toMatch(/will keep this site/i);
		expect(screen.queryByTestId('fe-storage-persist-request')).toBeNull();
	});

	it('asks for permission from the popup and turns green when granted', async () => {
		let granted = false;
		stubStorage(false, async () => {
			granted = true;
			return true;
		});
		render(StoragePersistenceStatus, { props: { pollMs: 0 } });
		const pill = await screen.findByTestId('fe-storage-persist');
		await vi.waitFor(() => expect(pill.getAttribute('data-status')).toBe('best-effort'));
		await fireEvent.click(pill);
		await fireEvent.click(screen.getByTestId('fe-storage-persist-request'));
		await vi.waitFor(() => expect(pill.getAttribute('data-status')).toBe('persistent'));
		expect(granted).toBe(true);
		expect(screen.getByTestId('fe-storage-persist-popup').classList.contains('persistent')).toBe(true);
		expect(screen.queryByTestId('fe-storage-persist-request')).toBeNull();
	});
});
