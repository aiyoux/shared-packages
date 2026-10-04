import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import OpProgressChip from '../src/ui/OpProgressChip.svelte';
import { startOp } from '../src/services/ops.ts';
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
