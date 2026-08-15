import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import OpProgressPopup from '../src/ui/OpProgressPopup.svelte';
import type { TransferItem } from '../src/transferRegistry.ts';

function item(partial: Partial<TransferItem> & Pick<TransferItem, 'id' | 'name'>): TransferItem {
	return {
		size: 100,
		transferred: 0,
		direction: 'copying',
		status: 'active',
		done: false,
		...partial
	};
}

describe('OpProgressPopup stacked bar', () => {
	it('renders one row for :remote + :wire with both fills', () => {
		render(OpProgressPopup, {
			props: {
				items: [
					item({ id: 'op1:remote', name: 'Download · B2', transferred: 80, size: 100 }),
					item({ id: 'op1:wire', name: 'photo.jpg · from peer', transferred: 30, size: 100 })
				]
			}
		});
		const rows = screen.getAllByTestId('fe-op-progress-row');
		expect(rows).toHaveLength(1);
		expect(rows[0]!.textContent).toMatch(/photo\.jpg/);
		expect(rows[0]!.textContent).toMatch(/30% sent · 80% ready/);
		expect(rows[0]!.querySelector('.op-fill.ahead')).toBeTruthy();
		expect(rows[0]!.querySelector('.op-fill.behind')).toBeTruthy();
	});

	it('dismisses both stacked ids', async () => {
		const onDismiss = vi.fn();
		render(OpProgressPopup, {
			props: {
				items: [
					item({
						id: 'op1:remote',
						name: 'Download · B2',
						transferred: 100,
						size: 100,
						done: true,
						status: 'done'
					}),
					item({
						id: 'op1:wire',
						name: 'photo.jpg · from peer',
						transferred: 100,
						size: 100,
						done: true,
						status: 'done'
					})
				],
				onDismiss
			}
		});
		await fireEvent.click(screen.getByLabelText('Dismiss'));
		expect(onDismiss.mock.calls.map((c) => c[0]).sort()).toEqual(['op1:remote', 'op1:wire']);
	});
});
