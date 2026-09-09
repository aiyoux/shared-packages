import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

if (typeof URL.createObjectURL !== 'function') {
	const blobs = new Map<string, Blob>();
	let n = 0;
	URL.createObjectURL = ((blob: Blob) => {
		const url = `blob:test-${++n}`;
		blobs.set(url, blob);
		return url;
	}) as typeof URL.createObjectURL;
	URL.revokeObjectURL = ((url: string) => {
		blobs.delete(url);
	}) as typeof URL.revokeObjectURL;
}
import {
	canQuickEditRaster,
	coerceMediaBlob,
	getPreviewKind,
	generateImageThumbnail
} from '../src/ui/feThumbnails.ts';
import type { ExplorerEntry } from '../src/ui/explorerDriver.ts';

function file(partial: Partial<ExplorerEntry> & Pick<ExplorerEntry, 'name'>): ExplorerEntry {
	return {
		id: 'n1',
		kind: 'file',
		parentId: null,
		...partial
	};
}

describe('getPreviewKind', () => {
	it('classifies by fileType, extension, and contentType', () => {
		assert.equal(getPreviewKind(file({ name: 'a.bin', fileType: 'pdf' })), 'pdf');
		assert.equal(getPreviewKind(file({ name: 'photo.SVG' })), 'image');
		assert.equal(getPreviewKind(file({ name: 'clip.webm' })), 'video');
		assert.equal(getPreviewKind(file({ name: 'song.mp3' })), 'audio');
		assert.equal(getPreviewKind(file({ name: 'take.WAV' })), 'audio');
		assert.equal(getPreviewKind(file({ name: 'x', fileType: 'audio' })), 'audio');
		assert.equal(getPreviewKind(file({ name: 'x', contentType: 'audio/mpeg' })), 'audio');
		assert.equal(getPreviewKind(file({ name: 'x', contentType: 'application/pdf' })), 'pdf');
		assert.equal(getPreviewKind(file({ name: 'notes.txt' })), null);
		assert.equal(getPreviewKind({ id: 'f', kind: 'folder', name: 'dir', parentId: null }), null);
	});
});

describe('canQuickEditRaster', () => {
	it('allows still rasters and rejects gif/svg/non-images', () => {
		assert.equal(canQuickEditRaster(file({ name: 'photo.png' })), true);
		assert.equal(canQuickEditRaster(file({ name: 'shot.JPEG' })), true);
		assert.equal(canQuickEditRaster(file({ name: 'x', fileType: 'image' })), true);
		assert.equal(canQuickEditRaster(file({ name: 'anim.gif' })), false);
		assert.equal(canQuickEditRaster(file({ name: 'icon.SVG' })), false);
		assert.equal(canQuickEditRaster(file({ name: 'clip.webm' })), false);
		assert.equal(canQuickEditRaster({ id: 'f', kind: 'folder', name: 'dir', parentId: null }), false);
	});
});

describe('coerceMediaBlob', () => {
	it('forces SVG and PDF MIME when the blob is untyped', () => {
		const raw = new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' });
		assert.equal(coerceMediaBlob(raw, 'icon.svg', 'image').type, 'image/svg+xml');
		assert.equal(coerceMediaBlob(raw, 'doc.pdf', 'pdf').type, 'application/pdf');
		assert.equal(coerceMediaBlob(raw, 'shot.png', 'image').type, 'image/png');
		assert.equal(coerceMediaBlob(raw, 'song.mp3', 'audio').type, 'audio/mpeg');
		assert.equal(coerceMediaBlob(raw, 'take.wav', 'audio').type, 'audio/wav');
	});
});

describe('generateImageThumbnail', () => {
	it('returns a blob URL for SVG without rasterizing onto canvas', async () => {
		const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], {
			type: 'application/octet-stream'
		});
		const url = await generateImageThumbnail(svg, 64, 'mark.svg');
		assert.match(url, /^blob:/);
		URL.revokeObjectURL(url);
	});
});
