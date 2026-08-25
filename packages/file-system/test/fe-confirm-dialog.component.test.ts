import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import FeConfirmDialog from '../src/ui/FeConfirmDialog.svelte';

describe('FeConfirmDialog', () => {
	it('shows copy and Confirm/Cancel fire', async () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		render(FeConfirmDialog, {
			props: {
				copy: { title: 'Delete', body: 'Permanently delete “x.bin”?', confirmLabel: 'Delete' },
				onConfirm,
				onCancel
			}
		});
		const dialog = screen.getByTestId('fe-confirm-dialog');
		expect(dialog.getAttribute('role')).toBe('dialog');
		expect(screen.getByTestId('fe-confirm-title').textContent).toBe('Delete');
		expect(screen.getByTestId('fe-confirm-body').textContent).toMatch(/x\.bin/);
		await fireEvent.click(screen.getByTestId('fe-confirm-cancel'));
		expect(onCancel).toHaveBeenCalledOnce();
		await fireEvent.click(screen.getByTestId('fe-confirm-go'));
		expect(onConfirm).toHaveBeenCalledOnce();
	});
});
