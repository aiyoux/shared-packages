import { describe, expect, it } from 'vitest';
import { loadEngine } from './engines.js';
import { expandBytes, packFiles } from './operations.js';

const SAMPLE = new TextEncoder().encode('wasm engine fixture payload '.repeat(80));

describe('zipkit wasm', () => {
	it('round-trips gzip and zip', async () => {
		const engine = await loadEngine('zipkit');
		const gz = await engine.compress(SAMPLE, 'gzip');
		const back = await engine.decompress(gz, 'gzip');
		expect(new TextDecoder().decode(back)).toBe(new TextDecoder().decode(SAMPLE));

		const archive = await engine.zip!([{ name: 'w.txt', data: SAMPLE }]);
		const files = await engine.unzip!(archive);
		expect(files).toHaveLength(1);
		expect(files[0]!.name).toBe('w.txt');
		expect(new TextDecoder().decode(files[0]!.data)).toBe(new TextDecoder().decode(SAMPLE));
	});

	it('expandBytes onEntry delivers ZIP members (extract-to-VFS path)', async () => {
		const packed = await packFiles('zipkit', [{ name: 'n.txt', data: SAMPLE }], 'zip');
		const seen: string[] = [];
		const files = await expandBytes('zipkit', packed[0]!.data, 'zip', packed[0]!.name, {
			onEntry: (entry) => {
				seen.push(entry.name);
			}
		});
		expect(files.length, 'streaming consumer owns the bytes; nothing retained').toBe(0);
		expect(seen).toEqual(['n.txt']);
	});

	it('unzip of an fflate ZIP still streams via onEntry', async () => {
		const packed = await packFiles('fflate', [{ name: 'n.txt', data: SAMPLE }], 'zip');
		const seen: string[] = [];
		await expandBytes('zipkit', packed[0]!.data, 'zip', packed[0]!.name, {
			onEntry: (entry) => {
				seen.push(entry.name);
			}
		});
		expect(seen).toEqual(['n.txt']);
	});
});

describe('zip.js', () => {
	it('round-trips zip', async () => {
		const engine = await loadEngine('zipjs');
		const archive = await engine.zip!([{ name: 'w.txt', data: SAMPLE }]);
		const files = await engine.unzip!(archive);
		expect(files).toHaveLength(1);
		expect(files[0]!.name).toBe('w.txt');
		expect(new TextDecoder().decode(files[0]!.data)).toBe(new TextDecoder().decode(SAMPLE));
	});

	it('expandBytes onEntry delivers ZIP members', async () => {
		const packed = await packFiles('zipjs', [{ name: 'n.txt', data: SAMPLE }], 'zip');
		const seen: string[] = [];
		const files = await expandBytes('zipjs', packed[0]!.data, 'zip', packed[0]!.name, {
			onEntry: (entry) => {
				seen.push(entry.name);
			}
		});
		expect(files.length).toBe(0);
		expect(seen).toEqual(['n.txt']);
	});

	it('unzips an fflate ZIP', async () => {
		const packed = await packFiles('fflate', [{ name: 'n.txt', data: SAMPLE }], 'zip');
		const files = await expandBytes('zipjs', packed[0]!.data, 'zip', packed[0]!.name);
		expect(files).toHaveLength(1);
		expect(new TextDecoder().decode(files[0]!.data)).toBe(new TextDecoder().decode(SAMPLE));
	});
});

describe('libarchive wasm', () => {
	it('unzips an fflate ZIP and untars nanotar', async () => {
		const zipped = await packFiles('fflate', [{ name: 'n.txt', data: SAMPLE }], 'zip');
		const fromZip = await expandBytes('libarchive', zipped[0]!.data, 'zip', zipped[0]!.name);
		expect(fromZip.map((f) => f.name)).toEqual(['n.txt']);
		expect(new TextDecoder().decode(fromZip[0]!.data)).toBe(new TextDecoder().decode(SAMPLE));

		const tarred = await packFiles('nanotar', [{ name: 't.txt', data: SAMPLE }], 'tar');
		const fromTar = await expandBytes('libarchive', tarred[0]!.data, 'tar', tarred[0]!.name);
		expect(fromTar.map((f) => f.name)).toEqual(['t.txt']);
		expect(new TextDecoder().decode(fromTar[0]!.data)).toBe(new TextDecoder().decode(SAMPLE));
	});

	it('streams ZIP members via onEntry', async () => {
		const packed = await packFiles('fflate', [{ name: 'n.txt', data: SAMPLE }], 'zip');
		const seen: string[] = [];
		const files = await expandBytes('libarchive', packed[0]!.data, 'zip', packed[0]!.name, {
			onEntry: (entry) => {
				seen.push(entry.name);
			}
		});
		expect(files.length).toBe(0);
		expect(seen).toEqual(['n.txt']);
	});

	it('cannot create 7z', async () => {
		await expect(packFiles('libarchive', [{ name: 'n.txt', data: SAMPLE }], '7z')).rejects.toThrow(
			/cannot create/
		);
	});
});

describe('addmaple wasm', () => {
	it('round-trips gzip via the gzip module', async () => {
		const packed = await packFiles('addmaple', [{ name: 'n.txt', data: SAMPLE }], 'gzip');
		expect(packed[0]!.data.byteLength).toBeGreaterThan(0);
		const expanded = await expandBytes('addmaple', packed[0]!.data, 'gzip', packed[0]!.name);
		expect(new TextDecoder().decode(expanded[0]!.data)).toBe(new TextDecoder().decode(SAMPLE));
	});

	it('cannot zip', async () => {
		await expect(packFiles('addmaple', [{ name: 'n.txt', data: SAMPLE }], 'zip')).rejects.toThrow(
			/does not support/
		);
	});
});
