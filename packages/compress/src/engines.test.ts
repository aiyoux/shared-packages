import { describe, expect, it } from 'vitest';
import { ENGINE_CATALOG, defaultCodecFor, engineSupports } from './types.js';
import { listEngines, loadEngine } from './engines.js';
import { expandBytes, packFiles } from './operations.js';

const SAMPLE = new TextEncoder().encode('scratch-pad compress fixture\n'.repeat(40));

describe('catalog', () => {
	it('lists fflate, ZipKit, and AddMaple', () => {
		expect(listEngines().map((e) => e.id)).toEqual(['fflate', 'zipkit', 'addmaple']);
		expect(ENGINE_CATALOG).toHaveLength(3);
	});

	it('keeps ZIP off AddMaple and on the other two', () => {
		expect(engineSupports('addmaple', 'zip')).toBe(false);
		expect(engineSupports('fflate', 'zip')).toBe(true);
		expect(engineSupports('zipkit', 'zstd')).toBe(true);
		expect(defaultCodecFor('addmaple')).toBe('gzip');
		expect(defaultCodecFor('fflate')).toBe('zip');
	});
});

describe('fflate', () => {
	it('round-trips gzip and zip', async () => {
		const engine = await loadEngine('fflate');
		const gz = await engine.compress(SAMPLE, 'gzip');
		expect(gz.byteLength).toBeLessThan(SAMPLE.byteLength);
		const back = await engine.decompress(gz, 'gzip');
		expect(new TextDecoder().decode(back)).toBe(new TextDecoder().decode(SAMPLE));

		const archive = await engine.zip!([
			{ name: 'a.txt', data: SAMPLE },
			{ name: 'nested/b.txt', data: new TextEncoder().encode('inner') }
		]);
		const files = await engine.unzip!(archive);
		expect(files.map((f) => f.name).sort()).toEqual(['a.txt', 'nested/b.txt']);
		expect(new TextDecoder().decode(files.find((f) => f.name === 'nested/b.txt')!.data)).toBe(
			'inner'
		);
	});

	it('packFiles / expandBytes go through the same path', async () => {
		const packed = await packFiles(
			'fflate',
			[{ name: 'note.txt', data: SAMPLE }],
			'gzip'
		);
		expect(packed).toHaveLength(1);
		expect(packed[0]!.name).toBe('note.txt.gz');
		const expanded = await expandBytes('fflate', packed[0]!.data, 'gzip', packed[0]!.name);
		expect(expanded).toHaveLength(1);
		expect(expanded[0]!.name).toBe('note.txt');
		expect(new TextDecoder().decode(expanded[0]!.data)).toBe(new TextDecoder().decode(SAMPLE));
	});

	it('rejects codecs it does not implement', async () => {
		await expect(packFiles('fflate', [{ name: 'x', data: SAMPLE }], 'brotli')).rejects.toThrow(
			/does not support/
		);
	});
});
