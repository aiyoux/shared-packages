import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	canReadExplorerBlob,
	loadExplorerMediaSrc,
	readExplorerBlob
} from '../src/ui/explorerDriver.ts';

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

	it('loadExplorerMediaSrc uses downloadUrl when present', async () => {
		const src = await loadExplorerMediaSrc(
			{
				downloadUrl: async () => ({ url: 'https://f000.example/file.pdf?Authorization=t', filename: 'file.pdf' }),
				download: async () => new Blob(['nope'])
			},
			'file.pdf'
		);
		assert.equal(src.url.startsWith('https://'), true);
		assert.equal(src.blob, undefined);
	});
});
