import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	canReadExplorerBlob,
	embedMediaUrl,
	loadExplorerMediaSrc,
	readExplorerBlob
} from '../src/ui/explorerDriver.ts';

if (typeof URL.createObjectURL !== 'function') {
	URL.createObjectURL = () => `blob:node/${Math.random()}`;
	URL.revokeObjectURL = () => {};
}

describe('readExplorerBlob', () => {
	it('prefers readBlob then download', async () => {
		const blob = new Blob(['from-read']);
		const got = await readExplorerBlob(
			{
				readBlob: async () => blob,
				download: async () => new Blob(['from-download'])
			},
			'x'
		);
		assert.equal(await got.text(), 'from-read');
		const dl = await readExplorerBlob({ download: async () => new Blob(['dl']) }, 'x');
		assert.equal(await dl.text(), 'dl');
		assert.equal(canReadExplorerBlob({ download: async () => new Blob() }), true);
		assert.equal(canReadExplorerBlob({}), false);
	});

	it('loadExplorerMediaSrc uses same-origin downloadUrl', async () => {
		const src = await loadExplorerMediaSrc(
			{
				downloadUrl: async () => ({
					url: 'http://127.0.0.1:7990/api/file.pdf',
					filename: 'file.pdf'
				}),
				download: async () => new Blob(['nope'])
			},
			'file.pdf',
			{ pageHref: 'http://127.0.0.1:7990/tools/files' }
		);
		assert.equal(src.url, 'http://127.0.0.1:7990/api/file.pdf');
		assert.equal(src.blob, undefined);
	});

	it('loadExplorerMediaSrc blobs a cross-origin monitor read URL', async () => {
		const src = await loadExplorerMediaSrc(
			{
				downloadUrl: async () => ({
					url: 'http://127.0.0.1:8300/v1/fs/read?path=%2Fissue.png&download=issue.png',
					filename: 'issue.png'
				}),
				download: async () => new Blob(['png-bytes'])
			},
			'issue.png',
			{ pageHref: 'http://127.0.0.1:7990/tools/files' }
		);
		assert.equal(src.url.startsWith('blob:'), true);
		assert.ok(src.blob);
		assert.equal(await src.blob!.text(), 'png-bytes');
	});

	it('embedMediaUrl keeps same-origin URLs and blobs monitor thumbs', async () => {
		const same = await embedMediaUrl(
			'http://127.0.0.1:7990/api/thumb.jpg',
			{ pageHref: 'http://127.0.0.1:7990/tools/files' }
		);
		assert.equal(same, 'http://127.0.0.1:7990/api/thumb.jpg');

		const orig = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(new Uint8Array([0xff, 0xd8]), {
				status: 200,
				headers: { 'content-type': 'image/jpeg' }
			})) as typeof fetch;
		try {
			const url = await embedMediaUrl(
				'http://127.0.0.1:8300/v1/fs/thumb?path=a.png',
				{ pageHref: 'http://127.0.0.1:7990/tools/files' }
			);
			assert.equal(url.startsWith('blob:'), true);
		} finally {
			globalThis.fetch = orig;
		}
	});
});
