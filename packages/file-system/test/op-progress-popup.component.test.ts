import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import CopyProgressHeader from '../src/ui/CopyProgressHeader.svelte';
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

describe('CopyProgressHeader', () => {
	it('renders one chip for :remote + :wire with first-stage % on the left', () => {
		render(CopyProgressHeader, {
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
		expect(rows[0]!.textContent).toMatch(/80% · 30%/);
		expect(rows[0]!.querySelector('.fill.ahead')).toBeTruthy();
		expect(rows[0]!.querySelector('.fill.behind')).toBeTruthy();
	});

	it('surfaces hop and ice on the row', () => {
		render(CopyProgressHeader, {
			props: {
				items: [
					item({
						id: 'w1',
						name: 'clip.wav',
						transferred: 10,
						size: 100,
						hop: 'webrtc',
						ice: 'checking'
					})
				]
			}
		});
		const row = screen.getByTestId('fe-op-progress-row');
		expect(row.getAttribute('data-copy-hop')).toBe('webrtc');
		expect(row.getAttribute('data-ice')).toBe('checking');
		expect(row.getAttribute('title')).toMatch(/WebRTC \(connecting\)/);
	});

	it('puts hop notes on the chip title', () => {
		const cases: Array<{ hop: TransferItem['hop']; ice?: TransferItem['ice']; icePath?: TransferItem['icePath']; hopNote?: string; text: string }> = [
			{ hop: 'server', text: 'Server copy' },
			{ hop: 'delegated', hopNote: 'Monitor ← B2', text: 'Monitor ← B2' },
			{ hop: 'delegated', hopNote: 'Monitor → B2', text: 'Monitor → B2' },
			{ hop: 'webrtc', icePath: 'host', text: 'WebRTC (host)' },
			{ hop: 'webrtc', icePath: 'stun', text: 'WebRTC (STUN)' },
			{ hop: 'dual-phase', ice: 'failed', text: 'WebRTC failed — through this device' },
			{ hop: 'direct', text: 'Through this device' }
		];
		for (const c of cases) {
			const { unmount } = render(CopyProgressHeader, {
				props: {
					items: [
						item({
							id: `h-${c.text}`,
							name: 'f.bin',
							transferred: 1,
							size: 10,
							hop: c.hop,
							ice: c.ice,
							icePath: c.icePath,
							hopNote: c.hopNote
						})
					]
				}
			});
			expect(screen.getByTestId('fe-op-progress-row').getAttribute('title')).toContain(c.text);
			unmount();
		}
	});

	it('opens a dropdown to dismiss stacked ids and clear finished', async () => {
		const onDismiss = vi.fn();
		const onDismissAll = vi.fn();
		render(CopyProgressHeader, {
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
				onDismiss,
				onDismissAll
			}
		});
		await fireEvent.click(screen.getByTestId('fe-op-progress-row'));
		await fireEvent.click(screen.getByLabelText('Dismiss'));
		expect(onDismiss.mock.calls.map((c) => c[0]).sort()).toEqual(['op1:remote', 'op1:wire']);
		await fireEvent.click(screen.getByTestId('fe-op-progress-dismiss'));
		expect(onDismissAll).toHaveBeenCalledTimes(1);
	});
});
