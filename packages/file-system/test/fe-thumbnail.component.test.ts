/**
 * FeThumbnail must not stay on the spinner when a same-id effect re-run
 * cancels the in-flight fetch (list refresh).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/svelte';
import FeThumbnail from '../src/ui/FeThumbnail.svelte';
import type { ExplorerDriver, ExplorerEntry } from '../src/ui/explorerDriver.ts';

vi.mock('../src/ui/feThumbnails.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/ui/feThumbnails.js')>();
	return {
		...actual,
		generateThumbnail: vi.fn(async () => 'data:image/webp;base64,AAA')
	};
});

const caps: ExplorerDriver['capabilities'] = {
	supportsTrash: false,
	supportsSoftDelete: false,
	supportsRename: false,
	supportsMove: false,
	supportsCopy: false,
	supportsMkdir: false,
	supportsUpload: false,
	supportsDownload: true,
	supportsSiblingOrder: false
};

function pngBlob(): Blob {
	// 1×1 PNG
	const bytes = Uint8Array.from([
		137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
		0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 0, 0, 3, 1,
		1, 0, 24, 221, 141, 219, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130
	]);
	return new Blob([bytes], { type: 'image/png' });
}

describe('FeThumbnail', () => {
	it('leaves the spinner after a cancelled first load of the same file', async () => {
		let resolveBlob: (b: Blob) => void = () => {};
		const first = new Promise<Blob>((r) => {
			resolveBlob = r;
		});
		let calls = 0;
		const driver: ExplorerDriver = {
			id: 'memory',
			capabilities: caps,
			ready: async () => {},
			list: async () => ({ entries: [], truncated: false }),
			getPath: async () => [],
			delete: async () => {},
			readBlob: async () => {
				calls += 1;
				if (calls === 1) return first;
				return pngBlob();
			}
		};
		const entry: ExplorerEntry = {
			id: 'img-1',
			kind: 'file',
			name: 'pic.png',
			parentId: null,
			fileType: 'image'
		};
		const { rerender } = render(FeThumbnail, {
			props: { entry, driver, maxDim: 32, enabled: true }
		});
		await waitFor(() => {
			expect(document.querySelector('.fe-thumb-spinner')).toBeTruthy();
		});
		// Same id, new object — used to skip the restart and leave loading=true
		// after the first fetch was cancelled.
		await rerender({
			entry: { ...entry },
			driver,
			maxDim: 32,
			enabled: true
		});
		resolveBlob(pngBlob());
		await waitFor(() => {
			expect(document.querySelector('.fe-thumb-spinner')).toBeNull();
		});
	});

	it('caps the thumbnail box to maxDim so list rows cannot grow with the image', async () => {
		const driver: ExplorerDriver = {
			id: 'memory',
			capabilities: caps,
			ready: async () => {},
			list: async () => ({ entries: [], truncated: false }),
			getPath: async () => [],
			delete: async () => {},
			readBlob: async () => pngBlob()
		};
		const entry: ExplorerEntry = {
			id: 'img-2',
			kind: 'file',
			name: 'wide.png',
			parentId: null,
			fileType: 'image'
		};
		render(FeThumbnail, {
			props: { entry, driver, maxDim: 16, enabled: true }
		});
		const box = document.querySelector('[data-testid="fe-thumb"]') as HTMLElement;
		expect(box).toBeTruthy();
		expect(box.style.getPropertyValue('--fe-thumb-max')).toBe('16px');
	});

	it('loads a remote image via download when readBlob is missing (B2)', async () => {
		const driver: ExplorerDriver = {
			id: 'b2',
			capabilities: caps,
			ready: async () => {},
			list: async () => ({ entries: [], truncated: false }),
			getPath: async () => [],
			delete: async () => {},
			download: async () => pngBlob()
		};
		const entry: ExplorerEntry = {
			id: 'photos/shot.png',
			kind: 'file',
			name: 'shot.png',
			parentId: null,
			fileType: 'image'
		};
		render(FeThumbnail, { props: { entry, driver, maxDim: 32, enabled: true } });
		await waitFor(() => {
			expect(document.querySelector('.fe-thumb-img')).toBeTruthy();
		});
		expect(document.querySelector('.fe-thumb-spinner')).toBeNull();
	});
});
