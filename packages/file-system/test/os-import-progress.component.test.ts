import { render } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import { installLockPolyfill } from './live-locks-harness.ts';
import FileExplorer from '../src/ui/FileExplorer.svelte';

installLockPolyfill();
import { createMemoryExplorerDriver } from '../src/ui/memoryExplorerDriver.js';
import { getMemoryVfs } from '../src/memoryVfs.js';
import { toast } from '@shared-packages/ui';
import { persistKv } from '@shared-packages/ui/persistKv';

function osFileDt(file: File) {
	const data = new Map<string, string>();
	return {
		data,
		setData: (type: string, val: string) => {
			data.set(type, val);
		},
		getData: (type: string) => data.get(type) ?? '',
		items: { add: (f: File) => void data.set('x-os-file', f.name) },
		files: [file],
		types: ['Files'],
		effectAllowed: 'all',
		dropEffect: 'copy'
	};
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
		await new Promise((r) => setTimeout(r, 25));
	}
}

describe('device import transfer rows', () => {
	it('an import from this device appears in the header as a progress item and completes', async () => {
		localStorage.clear();
		try {
			persistKv.removeItem('fe:viewMode');
			localStorage.setItem('fe:viewMode', 'list');
			const base = createMemoryExplorerDriver(getMemoryVfs());
			let release!: () => void;
			const gate = new Promise<void>((r) => (release = r));
			const driver = {
				...base,
				upload: async () => {
					await gate;
					return {
						id: 'f1',
						name: 'big.bin',
						kind: 'file' as const,
						size: 4,
						parentId: null
					};
				}
			};
			render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
			await waitFor(() => document.querySelector('[data-testid="fe-list"]') != null);
			expect(document.querySelector('[data-testid="fe-op-progress"]')).toBeNull();

			const file = new File([new Uint8Array(4)], 'big.bin', { type: 'application/octet-stream' });
			const dropEv = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
			Object.defineProperty(dropEv, 'dataTransfer', { value: osFileDt(file) });
			document.querySelector('[data-testid="fe-list"]')!.dispatchEvent(dropEv);

			// The header chip appears while the upload is gated.
			await waitFor(() => document.querySelector('[data-testid="fe-op-progress"]') != null);
			const row = document.querySelector('[data-testid="fe-op-progress-row"]')!;
			expect(row.getAttribute('data-name')).toBe('Import files');
			expect(row.getAttribute('data-status')).toBe('active');

			release();
			await waitFor(() => row.getAttribute('data-status') === 'done');
		} finally {
			persistKv.removeItem('fe:viewMode');
			localStorage.removeItem('fe:viewMode');
			toast.clear();
		}
	});

	it('a failed import marks its header row failed instead of spinning forever', async () => {
		localStorage.clear();
		try {
			persistKv.removeItem('fe:viewMode');
			localStorage.setItem('fe:viewMode', 'list');
			const base = createMemoryExplorerDriver(getMemoryVfs());
			const driver = {
				...base,
				upload: async () => {
					throw new Error('file exceeds max write size of 104857600 bytes');
				}
			};
			render(FileExplorer, { props: { mode: 'manage', driver, variant: 'panel' } });
			await waitFor(() => document.querySelector('[data-testid="fe-list"]') != null);
			const file = new File([new Uint8Array(4)], 'huge.bin', { type: 'application/octet-stream' });
			const dropEv = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
			Object.defineProperty(dropEv, 'dataTransfer', { value: osFileDt(file) });
			document.querySelector('[data-testid="fe-list"]')!.dispatchEvent(dropEv);

			await waitFor(() => {
				const row = document.querySelector('[data-testid="fe-op-progress-row"]');
				return row?.getAttribute('data-status') === 'failed' && /max write size/.test(row.getAttribute('title') ?? '');
			});
			const row = document.querySelector('[data-testid="fe-op-progress-row"]')!;
			expect(row.getAttribute('data-status')).toBe('failed');
		} finally {
			persistKv.removeItem('fe:viewMode');
			localStorage.removeItem('fe:viewMode');
			toast.clear();
		}
	});
});