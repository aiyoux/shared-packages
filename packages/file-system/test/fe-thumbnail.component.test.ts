/**
 * FeThumbnail must not stay on the spinner when a same-id effect re-run
 * cancels the in-flight fetch (list refresh).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/svelte';
import FeThumbnail from '../src/ui/FeThumbnail.svelte';
import type { ExplorerDriver, ExplorerEntry } from '../src/ui/explorerDriver.ts';
import {
	forgetThumbMemoryForTests,
	resetThumbCacheForTests
} from '../src/ui/thumbCache.ts';

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
	it('keeps a monitor blob across list refreshes and retires it after its img leaves the DOM', async () => {
		const thumbUrl = vi.fn(async () => ({ url: 'http://127.0.0.1:9847/v1/fs/thumb?path=pic.png' }));
		vi.stubGlobal('fetch', vi.fn(async () => new Response(pngBlob())));
		const driver: ExplorerDriver = {
			id: 'monitor', capabilities: caps, ready: async () => {},
			list: async () => ({ entries: [], truncated: false }), getPath: async () => [],
			delete: async () => {}, download: async () => pngBlob(), thumbUrl
		};
		const entry: ExplorerEntry = { id: 'pic.png', kind: 'file', name: 'pic.png', parentId: null };
		const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
			expect(document.querySelector(`img[src="${url}"]`)).toBeNull();
		});
		try {
			const view = render(FeThumbnail, { props: { entry, driver } });
			await waitFor(() => expect(document.querySelector('.fe-thumb-img')).toBeTruthy());
			const url = document.querySelector('.fe-thumb-img')!.getAttribute('src');
			await view.rerender({ entry: { ...entry }, driver });
			expect(thumbUrl).toHaveBeenCalledTimes(1);
			expect(document.querySelector('.fe-thumb-img')!.getAttribute('src')).toBe(url);
			expect(revoke).not.toHaveBeenCalled();
			await view.rerender({ entry, driver, enabled: false });
			await waitFor(() => expect(revoke).toHaveBeenCalledWith(url));
		} finally { revoke.mockRestore(); vi.unstubAllGlobals(); }
	});

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

	it('does not retry a failed decode in a loop', async () => {
		const { generateThumbnail } = await import('../src/ui/feThumbnails.js');
		vi.mocked(generateThumbnail).mockRejectedValue(new Error('not an image'));
		let reads = 0;
		const driver: ExplorerDriver = {
			id: 'local',
			capabilities: caps,
			ready: async () => {},
			list: async () => ({ entries: [], truncated: false }),
			getPath: async () => [],
			delete: async () => {},
			readBlob: async () => {
				reads += 1;
				return new Blob(['not a png'], { type: 'image/png' });
			}
		};
		const entry: ExplorerEntry = {
			id: 'ghost-1',
			kind: 'file',
			name: 'ghost.png',
			parentId: null,
			fileType: 'image'
		};
		const { rerender } = render(FeThumbnail, {
			props: { entry, driver, maxDim: 32, enabled: true, force: true }
		});
		await waitFor(() => {
			expect(document.querySelector('.fe-thumb-fallback')).toBeTruthy();
		});
		const afterFail = reads;
		expect(afterFail).toBeGreaterThan(0);
		await rerender({ entry: { ...entry }, driver, maxDim: 32, enabled: true, force: true });
		await new Promise((r) => setTimeout(r, 50));
		expect(reads).toBe(afterFail);
		vi.mocked(generateThumbnail).mockResolvedValue('data:image/webp;base64,AAA');
	});

	it('does not put a load-preview button on a text file', async () => {
		const driver: ExplorerDriver = {
			id: 'local',
			capabilities: caps,
			ready: async () => {},
			list: async () => ({ entries: [], truncated: false }),
			getPath: async () => [],
			delete: async () => {},
			readBlob: async () => new Blob(['hi'], { type: 'text/plain' })
		};
		const entry: ExplorerEntry = {
			id: 'note-1',
			kind: 'file',
			name: 'note.txt',
			parentId: null,
			fileType: 'text',
			contentType: 'text/plain'
		};
		render(FeThumbnail, { props: { entry, driver, maxDim: 32, enabled: true } });
		expect(document.querySelector('[data-testid="fe-thumb-load"]')).toBeNull();
		expect(document.querySelector('.fe-thumb-img')).toBeNull();
	});

	it('does not auto-download a B2 image; click loads it', async () => {
		let downloads = 0;
		const driver: ExplorerDriver = {
			id: 'b2',
			capabilities: caps,
			ready: async () => {},
			list: async () => ({ entries: [], truncated: false }),
			getPath: async () => [],
			delete: async () => {},
			download: async () => {
				downloads += 1;
				return pngBlob();
			}
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
			expect(document.querySelector('[data-testid="fe-thumb-load"]')).toBeTruthy();
		});
		expect(downloads).toBe(0);
		expect(document.querySelector('.fe-thumb-img')).toBeNull();
		await fireEvent.click(document.querySelector('[data-testid="fe-thumb-load"]')!);
		await waitFor(() => {
			expect(document.querySelector('.fe-thumb-img')).toBeTruthy();
		});
		expect(downloads).toBe(1);
	});

	it('auto-loads a monitor host thumb without downloading the original', async () => {
		let downloads = 0;
		const fetchMock = vi.fn(
			async () =>
				new Response(pngBlob(), { status: 200, headers: { 'content-type': 'image/jpeg' } })
		);
		vi.stubGlobal('fetch', fetchMock);
		const driver: ExplorerDriver = {
			id: 'monitor',
			capabilities: caps,
			ready: async () => {},
			list: async () => ({ entries: [], truncated: false }),
			getPath: async () => [],
			delete: async () => {},
			download: async () => {
				downloads += 1;
				return pngBlob();
			},
			thumbUrl: async () => ({ url: 'http://127.0.0.1:9847/v1/fs/thumb?path=a.png&size=32' })
		};
		const entry: ExplorerEntry = {
			id: 'a.png',
			kind: 'file',
			name: 'a.png',
			parentId: null,
			fileType: 'image'
		};
		render(FeThumbnail, { props: { entry, driver, maxDim: 32, enabled: true } });
		await waitFor(() => {
			const img = document.querySelector('.fe-thumb-img') as HTMLImageElement | null;
			expect(img?.src).toMatch(/^blob:/);
		});
		expect(downloads).toBe(0);
		expect(fetchMock).toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it('video rows never fall back to a whole-file download; icon instead', async () => {
		const download = vi.fn(async () => pngBlob());
		const fetchMock = vi.fn(async () => new Response('nope', { status: 415 }));
		vi.stubGlobal('fetch', fetchMock);
		try {
			// thumbUrl exists but the host poster fails (or cap off → null).
			const driver: ExplorerDriver = {
				id: 'monitor',
				capabilities: caps,
				ready: async () => {},
				list: async () => ({ entries: [], truncated: false }),
				getPath: async () => [],
				delete: async () => {},
				download,
				thumbUrl: async () => null
			};
			const entry: ExplorerEntry = {
				id: 'clip.mp4',
				kind: 'file',
				name: 'clip.mp4',
				parentId: null,
				fileType: 'video'
			};
			render(FeThumbnail, { props: { entry, driver, maxDim: 32, enabled: true } });
			await waitFor(() => {
				expect(document.querySelector('.fe-thumb-fallback')).toBeTruthy();
			});
			expect(download).not.toHaveBeenCalled();
			expect(document.querySelector('.fe-thumb-img')).toBeNull();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('video rows show the host poster when the monitor extracts one', async () => {
		const download = vi.fn(async () => pngBlob());
		const fetchMock = vi.fn(
			async () =>
				new Response(pngBlob(), { status: 200, headers: { 'content-type': 'image/jpeg' } })
		);
		vi.stubGlobal('fetch', fetchMock);
		try {
			const driver: ExplorerDriver = {
				id: 'monitor',
				capabilities: caps,
				ready: async () => {},
				list: async () => ({ entries: [], truncated: false }),
				getPath: async () => [],
				delete: async () => {},
				download,
				thumbUrl: async () => ({ url: 'http://127.0.0.1:9847/v1/fs/thumb?path=clip.mp4&size=32' })
			};
			const entry: ExplorerEntry = {
				id: 'clip.mp4',
				kind: 'file',
				name: 'clip.mp4',
				parentId: null,
				fileType: 'video'
			};
			render(FeThumbnail, { props: { entry, driver, maxDim: 32, enabled: true } });
			await waitFor(() => {
				expect(document.querySelector('.fe-thumb-img')).toBeTruthy();
			});
			expect(download).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('shows a cached thumbnail after unmount and after a refresh, and rebuilds when generation changes', async () => {
		await resetThumbCacheForTests();
		const { generateThumbnail } = await import('../src/ui/feThumbnails.js');
		vi.mocked(generateThumbnail).mockResolvedValue('data:image/webp;base64,QQ==');
		let reads = 0;
		const driver: ExplorerDriver = {
			id: 'local',
			capabilities: caps,
			ready: async () => {},
			list: async () => ({ entries: [], truncated: false }),
			getPath: async () => [],
			delete: async () => {},
			readBlob: async () => {
				reads += 1;
				return pngBlob();
			}
		};
		const entry: ExplorerEntry = {
			id: 'pic-cache',
			kind: 'file',
			name: 'pic.png',
			parentId: null,
			fileType: 'image',
			generation: 1,
			size: 40,
			updatedAt: 10
		};
		const first = render(FeThumbnail, { props: { entry, driver, maxDim: 32, enabled: true } });
		await waitFor(() => {
			expect(document.querySelector('.fe-thumb-img')?.getAttribute('data-thumb-source')).toBe('fresh');
		});
		expect(reads).toBe(1);
		first.unmount();

		forgetThumbMemoryForTests();
		const second = render(FeThumbnail, { props: { entry, driver, maxDim: 32, enabled: true } });
		await waitFor(() => {
			expect(document.querySelector('.fe-thumb-img')?.getAttribute('data-thumb-source')).toBe('cache');
		});
		expect(reads).toBe(1);
		second.unmount();

		const third = render(FeThumbnail, {
			props: { entry: { ...entry, generation: 2 }, driver, maxDim: 32, enabled: true }
		});
		await waitFor(() => {
			expect(document.querySelector('.fe-thumb-img')?.getAttribute('data-thumb-source')).toBe('fresh');
		});
		expect(reads).toBe(2);
		third.unmount();
		await resetThumbCacheForTests();
	});
});
