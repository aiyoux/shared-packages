import { expect, it } from 'vitest';
import { BlobReader, ZipReader, TextWriter } from '@zip.js/zip.js';
import { streamZip } from './streamZip.js';
import { expandBytes } from './operations.js';

it('streams a ZIP64 archive with nested files through a bounded writable', async () => {
	const pipe = new TransformStream<Uint8Array, Uint8Array>();
	const output = new Response(pipe.readable).blob();
	await streamZip((async function* () {
		yield { name: 'repo/a.txt', blob: new Blob(['alpha']) };
		yield { name: 'repo/deep/b.txt', blob: new Blob(['beta']) };
	})(), pipe.writable);
	const blob = await output;
	const withFflate = await expandBytes('fflate', new Uint8Array(await blob.arrayBuffer()), 'zip');
	expect(withFflate.map((entry) => entry.name)).toEqual(['repo/a.txt', 'repo/deep/b.txt']);
	const reader = new ZipReader(new BlobReader(blob));
	try {
		const entries = await reader.getEntries();
		expect(entries.map((entry) => entry.filename)).toEqual(['repo/a.txt', 'repo/deep/b.txt']);
		if (entries[0]?.directory || entries[1]?.directory) throw new Error('Expected files');
		expect(await entries[0]!.getData(new TextWriter())).toBe('alpha');
		expect(await entries[1]!.getData(new TextWriter())).toBe('beta');
	} finally {
		await reader.close();
	}
});
