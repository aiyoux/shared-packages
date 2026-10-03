/**
 * Floating preview must leave the spinner once the blob is in.
 * PDF used to bind the canvas only after loading=false, then return early
 * with the spinner still up.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import FeFloatingPreview from '../src/ui/FeFloatingPreview.svelte';
import type { ExplorerDriver, ExplorerEntry, MediaMetaTarget } from '../src/ui/explorerDriver.ts';

vi.mock('../src/ui/feThumbnails.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/ui/feThumbnails.js')>();
	return {
		...actual,
		renderPdfPageToCanvas: vi.fn(async (canvas: HTMLCanvasElement) => {
			canvas.width = 12;
			canvas.height = 16;
			return 2;
		})
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

function driverWith(blob: Blob): ExplorerDriver {
	return {
		id: 'memory',
		capabilities: caps,
		ready: async () => {},
		list: async () => ({ entries: [], truncated: false }),
		getPath: async () => [],
		delete: async () => {},
		readBlob: async () => blob
	};
}

const pdfEntry: ExplorerEntry = {
	id: 'pdf-1',
	kind: 'file',
	name: 'report.pdf',
	parentId: null,
	fileType: 'pdf',
	contentType: 'application/pdf',
	size: 12
};

const svgEntry: ExplorerEntry = {
	id: 'svg-1',
	kind: 'file',
	name: 'mark.svg',
	parentId: null,
	fileType: 'image',
	size: 40
};

describe('FeFloatingPreview', () => {
	it.each(['popup', 'dock'] as const)('shows JSON contents as text in the %s preview', async (variant) => {
		const text = '{\n  "message": "<b>hello</b>",\n  "count": 9007199254740993\n}';
		const blob = new Blob([text], { type: 'application/octet-stream' });
		const entry: ExplorerEntry = {
			id: 'json-1', kind: 'file', name: 'data.JSON', parentId: null,
			contentType: 'application/octet-stream'
		};
		// Remote connections may expose download rather than readBlob.
		const driver = { ...driverWith(blob), readBlob: undefined, download: vi.fn(async () => blob) };
		render(FeFloatingPreview, { props: { entry, driver, variant, onClose: () => {} } });
		const preview = screen.getByTestId(variant === 'dock' ? 'fe-preview-text' : 'fe-float-text');
		await waitFor(() => expect(preview.querySelector('pre')?.textContent).toBe(text));
		expect(preview.querySelector('b')).toBeNull();
		expect(driver.download).toHaveBeenCalledWith(entry.id);
	});

	it('previews incomplete JSON and truncates long docked contents', async () => {
		const text = '{"unfinished": "' + 'x'.repeat(5000);
		render(FeFloatingPreview, {
			props: {
				entry: { id: 'json-2', kind: 'file', name: 'unfinished.json', parentId: null },
				driver: driverWith(new Blob([text])), variant: 'dock', onClose: () => {}
			}
		});
		const preview = screen.getByTestId('fe-preview-text');
		await waitFor(() => expect(preview.querySelector('pre')?.textContent).toBe(text.slice(0, 4000)));
		expect(preview.getAttribute('data-truncated')).toBe('true');
	});

	it('keeps its image blob across same-file list refreshes and retires it after unmount', async () => {
		const readBlob = vi.fn(async () => new Blob(['image'], { type: 'image/png' }));
		const driver = { ...driverWith(new Blob()), readBlob };
		const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
			expect(document.querySelector(`img[src="${url}"]`)).toBeNull();
		});
		try {
			const props = { entry: { ...svgEntry, name: 'pic.png' }, driver, onClose: () => {} };
			const view = render(FeFloatingPreview, { props });
			await waitFor(() => expect(document.querySelector('.fe-float-image')).toBeTruthy());
			const url = document.querySelector('.fe-float-image')!.getAttribute('src');
			await view.rerender({ ...props, entry: { ...props.entry } });
			expect(readBlob).toHaveBeenCalledTimes(1);
			expect(document.querySelector('.fe-float-image')!.getAttribute('src')).toBe(url);
			expect(revoke).not.toHaveBeenCalled();
			view.unmount();
			await waitFor(() => expect(revoke).toHaveBeenCalledWith(url));
		} finally { revoke.mockRestore(); }
	});

	it('keeps the actions when an image fails to display', async () => {
		const actions = createRawSnippet(() => ({
			render: () => '<button type="button" data-testid="fe-row-trash">Delete</button>'
		}));
		const pngEntry: ExplorerEntry = {
			id: 'png-1',
			kind: 'file',
			name: 'ghost.png',
			parentId: null,
			fileType: 'image',
			contentType: 'image/png',
			size: 9
		};
		render(FeFloatingPreview, {
			props: {
				entry: pngEntry,
				driver: driverWith(new Blob(['not a png'], { type: 'image/png' })),
				onClose: () => {},
				actions
			}
		});
		// Shown in the image viewer's chrome, once.
		await waitFor(() => expect(document.querySelector('.fe-float-image')).toBeTruthy());
		expect(screen.getAllByTestId('fe-row-trash')).toHaveLength(1);
		// The bytes are not an image: the viewer goes, and the actions must not.
		document.querySelector('.fe-float-image')!.dispatchEvent(new Event('error'));
		await waitFor(() => expect(screen.getByText('Image failed to display')).toBeTruthy());
		expect(screen.getAllByTestId('fe-row-trash')).toHaveLength(1);
	});

	it('drops the spinner and shows a PDF canvas after the blob loads', async () => {
		render(FeFloatingPreview, {
			props: {
				entry: pdfEntry,
				driver: driverWith(new Blob([new Uint8Array([37, 80, 68, 70])], { type: 'application/pdf' })),
				onClose: () => {}
			}
		});
		expect(document.querySelector('.fe-float-spinner')).toBeTruthy();
		await waitFor(() => {
			expect(document.querySelector('.fe-float-spinner')).toBeNull();
		});
		expect(document.querySelector('.fe-float-pdf-canvas')).toBeTruthy();
		expect(screen.queryByText(/failed/i)).toBeNull();
	});

	it('shows an SVG as an image, not a stuck spinner', async () => {
		const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>'], {
			type: 'application/octet-stream'
		});
		render(FeFloatingPreview, {
			props: {
				entry: svgEntry,
				driver: driverWith(svg),
				onClose: () => {}
			}
		});
		await waitFor(() => {
			expect(document.querySelector('.fe-float-spinner')).toBeNull();
		});
		const img = document.querySelector('.fe-float-image') as HTMLImageElement | null;
		expect(img).toBeTruthy();
		expect(img?.src).toMatch(/^blob:/);
	});

	it('previews a PDF from download when the driver has no readBlob (B2)', async () => {
		const driver: ExplorerDriver = {
			id: 'b2',
			capabilities: caps,
			ready: async () => {},
			list: async () => ({ entries: [], truncated: false }),
			getPath: async () => [],
			delete: async () => {},
			download: async () => new Blob([new Uint8Array([37, 80, 68, 70])], { type: 'application/pdf' })
		};
		render(FeFloatingPreview, {
			props: { entry: pdfEntry, driver, onClose: () => {} }
		});
		await waitFor(() => {
			expect(document.querySelector('.fe-float-spinner')).toBeNull();
		});
		expect(document.querySelector('.fe-float-pdf-canvas')).toBeTruthy();
		expect(screen.queryByText(/not available/i)).toBeNull();
	});

	it('previews audio from a cross-origin downloadUrl via blob (CSP media-src self)', async () => {
		const driver: ExplorerDriver = {
			id: 'b2',
			capabilities: caps,
			ready: async () => {},
			list: async () => ({ entries: [], truncated: false }),
			getPath: async () => [],
			delete: async () => {},
			downloadUrl: async () => ({
				url: 'https://f000.example/song.mp3?Authorization=t',
				filename: 'song.mp3'
			}),
			download: async () => new Blob(['mp3-bytes'], { type: 'audio/mpeg' })
		};
		render(FeFloatingPreview, {
			props: {
				entry: {
					id: 'song.mp3',
					kind: 'file',
					name: 'song.mp3',
					parentId: null,
					fileType: 'audio',
					contentType: 'audio/mpeg'
				},
				driver,
				onClose: () => {}
			}
		});
		await waitFor(() => {
			expect(document.querySelector('.fe-float-spinner')).toBeNull();
		});
		const audio = document.querySelector('[data-testid="fe-float-audio"] audio') as HTMLAudioElement | null;
		expect(audio).toBeTruthy();
		expect(audio?.getAttribute('src')?.startsWith('blob:')).toBe(true);
		expect(audio?.hasAttribute('autoplay')).toBe(false);
	});

	it('does not autoplay video', async () => {
		render(FeFloatingPreview, {
			props: {
				entry: {
					id: 'clip.webm',
					kind: 'file',
					name: 'clip.webm',
					parentId: null,
					fileType: 'video',
					contentType: 'video/webm'
				},
				driver: driverWith(new Blob([new Uint8Array([1, 2, 3])], { type: 'video/webm' })),
				onClose: () => {}
			}
		});
		await waitFor(() => {
			expect(document.querySelector('video')).toBeTruthy();
		});
		expect(document.querySelector('video')?.hasAttribute('autoplay')).toBe(false);
	});

	it('previews an image from a same-origin downloadUrl without buffering bytes', async () => {
		const driver: ExplorerDriver = {
			id: 'local',
			capabilities: caps,
			ready: async () => {},
			list: async () => ({ entries: [], truncated: false }),
			getPath: async () => [],
			delete: async () => {},
			downloadUrl: async () => ({
				url: `${location.origin}/api/pic.png`,
				filename: 'pic.png'
			}),
			download: async () => new Blob(['nope'])
		};
		render(FeFloatingPreview, {
			props: { entry: { ...svgEntry, name: 'pic.png', id: 'pic.png' }, driver, onClose: () => {} }
		});
		await waitFor(() => {
			expect(document.querySelector('.fe-float-spinner')).toBeNull();
		});
		const img = document.querySelector('.fe-float-image') as HTMLImageElement | null;
		expect(img?.src).toBe(`${location.origin}/api/pic.png`);
	});

	it.each(['popup', 'dock'] as const)('lists a folder’s thumbnails and names in the %s preview', async (variant) => {
		const folder: ExplorerEntry = { id: 'dir-1', kind: 'folder', name: 'Shots', parentId: null };
		const children: ExplorerEntry[] = [
			{ id: 'child-img', kind: 'file', name: 'frame.png', parentId: 'dir-1', fileType: 'image', contentType: 'image/png', size: 8 },
			{ id: 'child-dir', kind: 'folder', name: 'raw', parentId: 'dir-1' },
			{ id: 'child-txt', kind: 'file', name: 'notes.txt', parentId: 'dir-1', fileType: 'text', size: 4 }
		];
		const list = vi.fn(async () => ({ entries: children, truncated: true }));
		const driver = { ...driverWith(new Blob(['x'])), list };
		render(FeFloatingPreview, { props: { entry: folder, driver, variant, onClose: () => {} } });
		const listing = await screen.findByTestId('fe-folder-preview');
		expect(list).toHaveBeenCalledWith({ parentId: 'dir-1' });
		const rows = [...listing.querySelectorAll('[data-testid="fe-folder-preview-item"]')];
		expect(rows.map((el) => el.getAttribute('data-name'))).toEqual(['frame.png', 'raw', 'notes.txt']);
		expect(listing.querySelectorAll('[data-testid="fe-thumb"]')).toHaveLength(3);
		expect(screen.getByTestId('fe-folder-preview-truncated').textContent).toMatch(/not shown/);
		expect(screen.queryByText('Preview not available for this file type')).toBeNull();
		expect(screen.queryByText('Folder is empty')).toBeNull();
	});

	it('offers folder metadata and replaces unknown size with calculate size', async () => {
		const folder: ExplorerEntry = {
			id: 'dir-1', kind: 'folder', name: 'Shots', parentId: null, updatedAt: Date.UTC(2026, 0, 2, 3, 4)
		};
		const list = vi.fn(async ({ parentId }: { parentId: string | null }) => {
			if (parentId === 'dir-1') {
				return {
					entries: [
						{ id: 'a.txt', kind: 'file', name: 'a.txt', parentId: 'dir-1', size: 10 },
						{ id: 'sub', kind: 'folder', name: 'sub', parentId: 'dir-1' }
					],
					truncated: false
				};
			}
			if (parentId === 'sub') {
				return {
					entries: [{ id: 'b.txt', kind: 'file', name: 'b.txt', parentId: 'sub', size: 5 }],
					truncated: false
				};
			}
			return { entries: [], truncated: false };
		});
		const driver = { ...driverWith(new Blob()), list };
		render(FeFloatingPreview, {
			props: {
				entry: folder,
				driver,
				infoLine: 'Unknown size · 2 Jan 2026',
				onClose: () => {}
			}
		});
		expect(screen.getByTestId('fe-float-meta-toggle').textContent).toBe('Show metadata');
		expect(screen.getByTestId('fe-folder-calc-size').textContent).toBe('Calculate size');
		expect(screen.queryByText(/Unknown size/)).toBeNull();
		expect(screen.getByTestId('fe-file-preview-info').textContent).toMatch(/2 Jan 2026/);

		await fireEvent.click(screen.getByTestId('fe-float-meta-toggle'));
		expect(screen.getByTestId('fe-float-meta-toggle').textContent).toBe('Hide metadata');
		const folderMeta = screen.getByTestId('fe-folder-meta');
		expect(folderMeta.closest('.fe-float-body')).toBeNull();
		expect(folderMeta.closest('.fe-float-meta-popover')).toBeNull();
		await waitFor(() => expect(screen.getByTestId('fe-folder-meta-items').textContent).toBe('2'));
		expect(screen.getByTestId('fe-folder-meta-folders').textContent).toBe('1');
		expect(screen.getByTestId('fe-folder-meta-files').textContent).toBe('1');
		expect(screen.getByTestId('fe-folder-meta-size').textContent).toBe('Not calculated');
		expect(screen.getByTestId('fe-folder-meta-modified').textContent).toBeTruthy();

		await fireEvent.click(screen.getByTestId('fe-folder-calc-size'));
		await waitFor(() => expect(screen.getByTestId('fe-folder-size').textContent).toBe('15 B'));
		expect(screen.queryByTestId('fe-folder-calc-size')).toBeNull();
		expect(screen.getByTestId('fe-folder-meta-files').textContent).toBe('2');
		expect(screen.getByTestId('fe-folder-meta-folders').textContent).toBe('1');
		expect(screen.getByTestId('fe-folder-meta-size').textContent).toBe('15 B');
		expect(list).toHaveBeenCalledWith({ parentId: 'sub' });
	});

	it('says a folder is empty when it has no children', async () => {
		const folder: ExplorerEntry = { id: 'dir-empty', kind: 'folder', name: 'Empty', parentId: null };
		render(FeFloatingPreview, {
			props: { entry: folder, driver: driverWith(new Blob()), onClose: () => {} }
		});
		expect((await screen.findByTestId('fe-folder-preview-empty')).textContent).toBe('Folder is empty');
		expect(screen.queryByText('Preview not available for this file type')).toBeNull();
		expect(screen.queryByTestId('fe-folder-preview')).toBeNull();
	});

	it('still says preview is unavailable for a file with no preview kind', async () => {
		render(FeFloatingPreview, {
			props: {
				entry: { id: 'bin-1', kind: 'file', name: 'blob.bin', parentId: null, size: 4 },
				driver: driverWith(new Blob(['nope'])),
				onClose: () => {}
			}
		});
		expect(await screen.findByText('Preview not available for this file type')).toBeTruthy();
		expect(screen.queryByTestId('fe-folder-preview')).toBeNull();
	});

	it.each([
		['image', { id: 'pic-1', kind: 'file' as const, name: 'pic.png', parentId: null, contentType: 'image/png', size: 8 }],
		['video', { id: 'vid-1', kind: 'file' as const, name: 'clip.webm', parentId: null, contentType: 'video/webm', size: 8 }]
	])('lays %s metadata over the preview stage', async (_label, entry) => {
		const mediaMeta = createRawSnippet<[MediaMetaTarget]>((getTarget) => ({
			render: () => `<p data-testid="fe-meta-probe">${getTarget().entry.name}</p>`
		}));
		render(FeFloatingPreview, {
			props: {
				entry,
				driver: driverWith(new Blob(['bytes'])),
				onClose: () => {},
				mediaMeta
			}
		});
		const toggle = screen.getByTestId('fe-float-meta-toggle');
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(screen.queryByTestId('fe-float-meta')).toBeNull();
		await fireEvent.click(toggle);
		const pop = screen.getByTestId('fe-float-meta');
		expect(pop.classList.contains('fe-float-meta-popover')).toBe(true);
		expect(pop.parentElement?.classList.contains('fe-float-body')).toBe(true);
		expect(pop.getAttribute('role')).toBe('region');
		expect(screen.getByTestId('fe-meta-probe').textContent).toBe(entry.name);
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		expect(getComputedStyle(pop).position).toBe('absolute');
		await fireEvent.click(toggle);
		expect(screen.queryByTestId('fe-float-meta')).toBeNull();
	});

	it('hides the metadata button when the host does not provide a panel', () => {
		render(FeFloatingPreview, {
			props: {
				entry: { id: 'pic-2', kind: 'file', name: 'pic.png', parentId: null, contentType: 'image/png', size: 8 },
				driver: driverWith(new Blob(['bytes'])),
				onClose: () => {}
			}
		});
		expect(screen.queryByTestId('fe-float-meta-toggle')).toBeNull();
	});

	it('does not offer media metadata for audio', () => {
		const mediaMeta = createRawSnippet<[MediaMetaTarget]>(() => ({
			render: () => '<p data-testid="fe-meta-probe">nope</p>'
		}));
		render(FeFloatingPreview, {
			props: {
				entry: { id: 'aud-1', kind: 'file', name: 'song.mp3', parentId: null, contentType: 'audio/mpeg', size: 8 },
				driver: driverWith(new Blob(['bytes'])),
				onClose: () => {},
				mediaMeta
			}
		});
		expect(screen.queryByTestId('fe-float-meta-toggle')).toBeNull();
	});

	it('falls back to an iframe when PDF rendering throws', async () => {
		const { renderPdfPageToCanvas } = await import('../src/ui/feThumbnails.js');
		vi.mocked(renderPdfPageToCanvas).mockRejectedValue(new Error('no wasm'));
		try {
			render(FeFloatingPreview, {
				props: {
					entry: pdfEntry,
					driver: driverWith(new Blob([new Uint8Array([37, 80, 68, 70])])),
					onClose: () => {}
				}
			});
			await waitFor(() => {
				expect(document.querySelector('.fe-float-pdf-frame')).toBeTruthy();
			});
			expect(document.querySelector('.fe-float-spinner')).toBeNull();
		} finally {
			vi.mocked(renderPdfPageToCanvas).mockImplementation(async (canvas: HTMLCanvasElement) => {
				canvas.width = 12;
				canvas.height = 16;
				return 2;
			});
		}
	});
});
