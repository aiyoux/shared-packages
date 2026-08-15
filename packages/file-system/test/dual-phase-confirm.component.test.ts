import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import DualPhaseConfirm from '../src/ui/DualPhaseConfirm.svelte';

describe('DualPhaseConfirm', () => {
	it('explains the two-leg copy and Confirm/Cancel fire', async () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		render(DualPhaseConfirm, {
			props: {
				sourceLabel: 'B2 · shots',
				destLabel: 'Monitor · home',
				onConfirm,
				onCancel
			}
		});
		const dialog = screen.getByTestId('fe-dual-phase-confirm');
		expect(dialog.getAttribute('role')).toBe('dialog');
		expect(dialog.textContent).toMatch(/Dual-phase transfer/);
		expect(dialog.textContent).toMatch(/B2 · shots/);
		expect(dialog.textContent).toMatch(/Monitor · home/);
		await fireEvent.click(screen.getByTestId('fe-dual-phase-cancel'));
		expect(onCancel).toHaveBeenCalledOnce();
		await fireEvent.click(screen.getByTestId('fe-dual-phase-confirm-go'));
		expect(onConfirm).toHaveBeenCalledOnce();
	});
});
