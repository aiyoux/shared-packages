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
