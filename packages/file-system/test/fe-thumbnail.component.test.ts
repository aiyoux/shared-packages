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
		const mark = document.querySelector('[data-testid="fe-type-mark"]');
		expect(mark?.getAttribute('data-icon')).toBe('file-text');
		expect(mark?.getAttribute('data-ext')).toBe('txt');
		expect(mark?.textContent).toMatch(/txt/);
	});

	it('shows the music icon and wav under an audio thumbnail', async () => {
		const driver: ExplorerDriver = {
			id: 'local',
			capabilities: caps,
			ready: async () => {},
			list: async () => ({ entries: [], truncated: false }),
			getPath: async () => [],
			delete: async () => {},
			readBlob: async () => new Blob(['RIFF'], { type: 'audio/wav' })
		};
		const entry: ExplorerEntry = {
			id: 'take-1',
			kind: 'file',
			name: 'take.WAV',
			parentId: null,
			fileType: 'audio'
		};
		render(FeThumbnail, { props: { entry, driver, maxDim: 96, enabled: true } });
		const mark = document.querySelector('[data-testid="fe-type-mark"]');
		expect(mark?.getAttribute('data-icon')).toBe('music');
		expect(mark?.getAttribute('data-ext')).toBe('wav');
		expect(mark?.textContent).toMatch(/wav/);
		expect(document.querySelector('[data-testid="fe-thumb-load"]')).toBeNull();
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
			expect(document.querySelector('[data-testid="fe-thumb-play"]')).toBeNull();
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
			const mark = document.querySelector('[data-testid="fe-thumb-play"]');
			expect(mark).toBeTruthy();
			expect(mark?.getAttribute('aria-hidden')).toBe('true');
			expect(getComputedStyle(mark as Element).pointerEvents).toBe('none');
			expect(download).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('puts a play mark on a video poster and leaves stills unmarked', async () => {
		const driver: ExplorerDriver = {
			id: 'local',
			capabilities: caps,
			ready: async () => {},
			list: async () => ({ entries: [], truncated: false }),
			getPath: async () => [],
			delete: async () => {},
			readBlob: async () => pngBlob()
		};
		const video: ExplorerEntry = {
			id: 'clip-1',
			kind: 'file',
			name: 'clip.mp4',
			parentId: null,
			fileType: 'video'
		};
		const view = render(FeThumbnail, { props: { entry: video, driver, maxDim: 64, enabled: true } });
		await waitFor(() => {
			expect(document.querySelector('[data-testid="fe-thumb-play"]')).toBeTruthy();
		});
		view.unmount();

		const still: ExplorerEntry = {
			id: 'pic-1',
			kind: 'file',
			name: 'pic.png',
			parentId: null,
			fileType: 'image'
		};
		render(FeThumbnail, { props: { entry: still, driver, maxDim: 64, enabled: true } });
		await waitFor(() => {
			expect(document.querySelector('.fe-thumb-img')).toBeTruthy();
		});
		expect(document.querySelector('[data-testid="fe-thumb-play"]')).toBeNull();
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
	it('defers offscreen tiles, shares visible requests, and aborts when they leave', async () => {
		await resetThumbCacheForTests();
		let notify!: IntersectionObserverCallback;
		vi.stubGlobal('IntersectionObserver', class {
			constructor(callback: IntersectionObserverCallback) { notify = callback; }
			observe() {} unobserve() {} disconnect() {}
		});
		let signal!: AbortSignal;
		const fetchMock = vi.fn((_url: string, options: RequestInit) => {
			signal = options.signal!;
			return new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
		});
		vi.stubGlobal('fetch', fetchMock);
		const driver: ExplorerDriver = {
			id: 'monitor', thumbScope: 'viewport', capabilities: caps, ready: async () => {},
			list: async () => ({ entries: [], truncated: false }), getPath: async () => [], delete: async () => {},
			thumbUrl: async () => ({ url: 'http://localhost/thumb' })
		};
		const entry: ExplorerEntry = { id: 'video', kind: 'file', name: 'video.mp4', parentId: null, size: 100, updatedAt: 1 };
		const first = render(FeThumbnail, { props: { entry, driver } });
		const second = render(FeThumbnail, { props: { entry, driver } });
		const nodes = [...document.querySelectorAll('[data-testid="fe-thumb"]')];
		const intersect = (target: Element, isIntersecting: boolean) => notify([{ target, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
		try {
			await new Promise((r) => setTimeout(r, 30));
			expect(fetchMock).not.toHaveBeenCalled();
			for (const node of nodes) intersect(node, true);
			await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
			intersect(nodes[0], false);
			await new Promise((r) => setTimeout(r, 10));
			expect(signal.aborted).toBe(false);
			intersect(nodes[1], false);
			await waitFor(() => expect(signal.aborted).toBe(true));
		} finally { first.unmount(); second.unmount(); vi.unstubAllGlobals(); }
	});

	it('downloads remote PDFs only on request, then reuses their cached thumbnails', async () => {
		await resetThumbCacheForTests();
		const download = vi.fn(async () => new Blob(['pdf']));
		const driver: ExplorerDriver = {
			id: 'monitor', thumbScope: 'pdfs', capabilities: caps, ready: async () => {},
			list: async () => ({ entries: [], truncated: false }), getPath: async () => [], delete: async () => {},
			thumbUrl: async () => null, download
		};
		const entry: ExplorerEntry = { id: 'doc.pdf', kind: 'file', name: 'doc.pdf', parentId: null, size: 100, updatedAt: 1 };
		const first = render(FeThumbnail, { props: { entry, driver } });
		await waitFor(() => expect(document.querySelector('[data-testid="fe-thumb-load"]')).toBeTruthy());
		expect(download).not.toHaveBeenCalled();
		await fireEvent.click(document.querySelector('[data-testid="fe-thumb-load"]')!);
		await waitFor(() => expect(document.querySelector('.fe-thumb-img')).toBeTruthy());
		expect(download).toHaveBeenCalledTimes(1);
		first.unmount(); forgetThumbMemoryForTests();
		const second = render(FeThumbnail, { props: { entry, driver } });
		await waitFor(() => expect(document.querySelector('.fe-thumb-img')?.getAttribute('data-thumb-source')).toBe('cache'));
		expect(download).toHaveBeenCalledTimes(1);
		second.unmount();
	});

	it('remembers unavailable host posters across remounts without downloading originals', async () => {
		await resetThumbCacheForTests();
		const fetchMock = vi.fn(async () => new Response('unavailable', { status: 415 }));
		vi.stubGlobal('fetch', fetchMock);
		const download = vi.fn();
		const driver: ExplorerDriver = {
			id: 'monitor', thumbScope: 'failures', capabilities: caps, ready: async () => {},
			list: async () => ({ entries: [], truncated: false }), getPath: async () => [], delete: async () => {},
			thumbUrl: async () => ({ url: 'http://localhost/thumb' }), download
		};
		const entry: ExplorerEntry = { id: 'bad.mov', kind: 'file', name: 'bad.mov', parentId: null, size: 100, updatedAt: 1 };
		const first = render(FeThumbnail, { props: { entry, driver } });
		try {
			await waitFor(() => expect(document.querySelector('[data-testid="fe-thumb-retry"]')).toBeTruthy());
			first.unmount(); forgetThumbMemoryForTests();
			const second = render(FeThumbnail, { props: { entry, driver } });
			await waitFor(() => expect(document.querySelector('[data-testid="fe-thumb-retry"]')).toBeTruthy());
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(download).not.toHaveBeenCalled();
			second.unmount();
		} finally { first.unmount(); vi.unstubAllGlobals(); }
	});

	it('waits for changing files to settle and versions the HTTP thumbnail URL', async () => {
		await resetThumbCacheForTests();
		const fetchMock = vi.fn(async (_url: string, _options: RequestInit) => new Response(pngBlob()));
		vi.stubGlobal('fetch', fetchMock);
		const driver: ExplorerDriver = {
			id: 'monitor', thumbScope: 'changing', capabilities: caps, ready: async () => {},
			list: async () => ({ entries: [], truncated: false }), getPath: async () => [], delete: async () => {},
			thumbUrl: async () => ({ url: 'http://localhost/thumb?path=clip.mp4' })
		};
		const entry: ExplorerEntry = { id: 'clip.mp4', name: 'clip.mp4', kind: 'file', parentId: null, size: 100, updatedAt: 1 };
		const view = render(FeThumbnail, { props: { entry, driver } });
		try {
			await waitFor(() => expect(document.querySelector('.fe-thumb-img')).toBeTruthy());
			await view.rerender({ entry: { ...entry, size: 200, updatedAt: 2 }, driver });
			await view.rerender({ entry: { ...entry, size: 300, updatedAt: 3 }, driver });
			await new Promise((r) => setTimeout(r, 50));
			expect(fetchMock).toHaveBeenCalledTimes(1);
			await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 1500 });
			const urls = fetchMock.mock.calls.map(([url]) => new URL(url));
			expect(urls[0].searchParams.get('v')).toBe('m:100:1');
			expect(urls[1].searchParams.get('v')).toBe('m:300:3');
		} finally { view.unmount(); vi.unstubAllGlobals(); }
	});

});
