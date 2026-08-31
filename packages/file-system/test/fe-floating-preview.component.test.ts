/**
 * Floating preview must leave the spinner once the blob is in.
 * PDF used to bind the canvas only after loading=false, then return early
 * with the spinner still up.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import FeFloatingPreview from '../src/ui/FeFloatingPreview.svelte';
import type { ExplorerDriver, ExplorerEntry } from '../src/ui/explorerDriver.ts';

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
