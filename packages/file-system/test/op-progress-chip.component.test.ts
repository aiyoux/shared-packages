import { render, fireEvent, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import OpProgressChip from '../src/ui/OpProgressChip.svelte';
import { startOp, opsService } from '../src/services/ops.ts';
import { installLockPolyfill } from './live-locks-harness.ts';

installLockPolyfill();

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
		await new Promise((r) => setTimeout(r, 25));
	}
}

describe('OpProgressChip', () => {
	it('shows pending cancellation and failures, and lets an active job be dismissed', async () => {
		const op = await startOp({ kind: 'copy', app: 'files', title: 'stuck.txt', windowId: 'stuck-pane', where: { executor: 'monitor' } });
		const service = await opsService();
		render(OpProgressChip, { props: { windowId: 'stuck-pane' } });
		await waitFor(() => !!document.querySelector('[data-window="stuck-pane"] .chip'));
		await fireEvent.click(document.querySelector('[data-window="stuck-pane"] .chip')!);
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		await waitFor(() => document.body.textContent?.includes('Cancellation requested.') === true);
		expect(service.get(op.id)?.state).toBe('running');
		await service.change(op.id, (row) => ({ ...row, cancelError: 'Could not cancel: Permission denied' }));
		await waitFor(() => document.body.textContent?.includes('Permission denied') === true);
		expect(screen.getByRole('alert').textContent).toContain('Permission denied');
		const dismiss = vi.spyOn(service, 'dismiss').mockRejectedValueOnce(new Error('Storage unavailable'));
		await fireEvent.click(screen.getByRole('button', { name: 'Dismiss from list' }));
		await waitFor(() => document.body.textContent?.includes('Storage unavailable') === true);
		await fireEvent.click(screen.getByRole('button', { name: 'Dismiss from list' }));
		await waitFor(() => !document.querySelector('[data-window="stuck-pane"] .chip'));
		expect(service.get(op.id)?.dismissed).toBeTruthy();
		expect(service.get(op.id)?.state).toBe('running');
		dismiss.mockRestore(); await op.cancelled();
	});
	it('shows ops that started in this window and leaves the other window blank', async () => {
		const mine = await startOp({
			kind: 'copy',
			app: 'files',
			title: 'mine.txt',
			windowId: 'pane-a',
			where: { executor: 'this-browser', route: 'direct' }
		});
		mine.progress({ done: 1, total: 4, note: 'Through this device' });
		await startOp({
			kind: 'copy',
			app: 'files',
			title: 'other.txt',
			windowId: 'pane-b',
			where: { executor: 'this-browser' }
		});
		await startOp({
			kind: 'copy',
			app: 'files',
			title: 'tab-wide.txt',
			where: { executor: 'this-browser' }
		});

		render(OpProgressChip, { props: { windowId: 'pane-a' } });
		render(OpProgressChip, { props: { windowId: 'pane-b' } });
		render(OpProgressChip, { props: { windowId: 'pane-c' } });

		await waitFor(() => document.querySelectorAll('[data-testid="fe-op-progress-row"]').length === 2);
		const names = [...document.querySelectorAll('[data-testid="fe-op-progress-row"]')].map((el) =>
			el.getAttribute('data-name')
		);
		expect(names.sort()).toEqual(['mine.txt', 'other.txt']);
		expect(document.body.textContent).not.toContain('tab-wide.txt');
		const mineRow = [...document.querySelectorAll('[data-testid="fe-op-progress-row"]')].find(
			(el) => el.getAttribute('data-name') === 'mine.txt'
		)!;
		expect(mineRow.getAttribute('data-copy-hop')).toBe('direct');
		expect(mineRow.getAttribute('data-window') ?? mineRow.closest('[data-window]')?.getAttribute('data-window')).toBe(
			'pane-a'
		);
		expect(document.querySelector('[data-window="pane-c"] [data-testid="fe-op-progress"]')).toBeNull();

		mine.progress({ done: 4, total: 4 });
		await mine.done();
		await waitFor(() => mineRow.getAttribute('data-status') === 'done');
	});
});
