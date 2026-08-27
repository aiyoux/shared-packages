import { describe, expect, it } from 'vitest';
import { ENGINE_CATALOG, defaultCodecFor, engineSupports } from './types.js';
import { listEngines, loadEngine } from './engines.js';
import { expandBytes, packFiles } from './operations.js';

const SAMPLE = new TextEncoder().encode('scratch-pad compress fixture\n'.repeat(40));

describe('catalog', () => {
	it('lists all engines', () => {
		expect(listEngines().map((e) => e.id)).toEqual(['fflate', 'zipkit', 'addmaple', 'tarjs', 'nanotar']);
		expect(ENGINE_CATALOG).toHaveLength(5);
	});

	it('keeps ZIP off AddMaple and on the other two', () => {
		expect(engineSupports('addmaple', 'zip')).toBe(false);
		expect(engineSupports('fflate', 'zip')).toBe(true);
		expect(engineSupports('zipkit', 'zstd')).toBe(true);
		expect(defaultCodecFor('addmaple')).toBe('gzip');
		expect(defaultCodecFor('fflate')).toBe('zip');
	});

	it('tar engines support tar and default to it', () => {
		expect(engineSupports('tarjs', 'tar')).toBe(true);
		expect(engineSupports('nanotar', 'tar')).toBe(true);
		expect(engineSupports('fflate', 'tar')).toBe(false);
		expect(defaultCodecFor('tarjs')).toBe('tar');
		expect(defaultCodecFor('nanotar')).toBe('tar');
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

	it('expandBytes drops Finder __MACOSX and AppleDouble members', async () => {
		const packed = await packFiles(
			'fflate',
			[
				{ name: 'photo.jpg', data: SAMPLE },
				{ name: '__MACOSX/._photo.jpg', data: new Uint8Array([0, 5, 22, 7]) },
				{ name: '._hidden', data: new Uint8Array([1]) },
				{ name: '.DS_Store', data: new Uint8Array([2]) }
			],
			'zip'
		);
		const files = await expandBytes('fflate', packed[0]!.data, 'zip', packed[0]!.name);
		expect(files.map((f) => f.name)).toEqual(['photo.jpg']);
		const kept = await expandBytes('fflate', packed[0]!.data, 'zip', packed[0]!.name, {
			skipSystemFiles: false
		});
		expect(kept.map((f) => f.name).sort()).toEqual([
			'.DS_Store',
			'._hidden',
			'__MACOSX/._photo.jpg',
			'photo.jpg'
		]);
	});

	it('unzip reports each member so the UI can tick dest rows', async () => {
		const engine = await loadEngine('fflate');
		const archive = await engine.zip!([
			{ name: 'a.txt', data: SAMPLE },
			{ name: 'b.txt', data: new TextEncoder().encode('b') }
		]);
		const names: string[] = [];
		const files = await engine.unzip!(archive, {
			onMember: (ev) => {
				if (ev.done) names.push(ev.name);
			}
		});
		expect(names.sort()).toEqual(['a.txt', 'b.txt']);
		expect(files).toHaveLength(2);
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

describe('tarjs', () => {
	it('round-trips tar', async () => {
		const engine = await loadEngine('tarjs');
		const archive = await engine.tar!([
			{ name: 'a.txt', data: SAMPLE },
			{ name: 'nested/b.txt', data: new TextEncoder().encode('inner') }
		]);
		const files = await engine.untar!(archive);
		expect(files.map((f) => f.name).sort()).toEqual(['a.txt', 'nested/b.txt']);
		expect(new TextDecoder().decode(files.find((f) => f.name === 'nested/b.txt')!.data)).toBe(
			'inner'
		);
	});

	it('packFiles / expandBytes round-trip tar', async () => {
		const packed = await packFiles(
			'tarjs',
			[{ name: 'note.txt', data: SAMPLE }],
			'tar'
		);
		expect(packed).toHaveLength(1);
		expect(packed[0]!.name).toBe('note.tar');
		const expanded = await expandBytes('tarjs', packed[0]!.data, 'tar', packed[0]!.name);
		expect(expanded).toHaveLength(1);
		expect(expanded[0]!.name).toBe('note.txt');
		expect(new TextDecoder().decode(expanded[0]!.data)).toBe(new TextDecoder().decode(SAMPLE));
	});

	it('reads a real ustar tar (GNU-style headers, numeric type codes)', async () => {
		// Field report: legitimate tar files did not extract at all. tarjs's
		// TarReader reports header `type` as an ASCII char code at runtime
		// (48 = '0' regular file, 53 = '5' directory) while the engine wrapper
		// compared against 0 — so every regular file was filtered out and
		// untar returned [] ("Nothing to extract").
		const header = (name: string, type: string, size: number): Uint8Array => {
			const block = new Uint8Array(512);
			block.set(new TextEncoder().encode(name).slice(0, 100), 0);
			block.set(new TextEncoder().encode('0000644'), 100);
			block.set(new TextEncoder().encode('0000000'), 108);
			block.set(new TextEncoder().encode('0000000'), 116);
			block.set(new TextEncoder().encode(size.toString(8).padStart(11, '0')), 124);
			block.set(new TextEncoder().encode(type), 156);
			block.set(new TextEncoder().encode('ustar'), 257);
			block.set(new TextEncoder().encode('00'), 263);
			return block;
		};
		const fileData = new TextEncoder().encode('tar body');
		const blocks: Uint8Array[] = [
			header('tooldir/', '5', 0),
			header('tooldir/a.txt', '0', fileData.length),
			new Uint8Array(fileData),
			// pad to 512
			new Uint8Array((512 - (fileData.length % 512)) % 512),
			new Uint8Array(1024) // end-of-archive
		];
		const archive = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
		let off = 0;
		for (const b of blocks) {
			archive.set(b, off);
			off += b.length;
		}
		for (const id of ['tarjs', 'nanotar'] as const) {
			const engine = await loadEngine(id);
			const files = await engine.untar!(archive);
			expect(files.map((f) => f.name)).toEqual(['tooldir/a.txt']);
			expect(new TextDecoder().decode(files[0]!.data)).toBe('tar body');
		}
	});
});

describe('nanotar', () => {
	it('round-trips tar', async () => {
		const engine = await loadEngine('nanotar');
		const archive = await engine.tar!([
			{ name: 'a.txt', data: SAMPLE },
			{ name: 'nested/b.txt', data: new TextEncoder().encode('inner') }
		]);
		const files = await engine.untar!(archive);
		expect(files.map((f) => f.name).sort()).toEqual(['a.txt', 'nested/b.txt']);
		expect(new TextDecoder().decode(files.find((f) => f.name === 'nested/b.txt')!.data)).toBe(
			'inner'
		);
	});

	it('packFiles / expandBytes round-trip tar', async () => {
		const packed = await packFiles(
			'nanotar',
			[{ name: 'note.txt', data: SAMPLE }],
			'tar'
		);
		expect(packed).toHaveLength(1);
		expect(packed[0]!.name).toBe('note.tar');
		const expanded = await expandBytes('nanotar', packed[0]!.data, 'tar', packed[0]!.name);
		expect(expanded).toHaveLength(1);
		expect(expanded[0]!.name).toBe('note.txt');
		expect(new TextDecoder().decode(expanded[0]!.data)).toBe(new TextDecoder().decode(SAMPLE));
	});
});
