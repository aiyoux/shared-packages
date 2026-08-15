import { describe, expect, it } from 'vitest';
import {
	detectFormat,
	detectFormatFromBytes,
	detectFormatFromName,
	extensionForCodec,
	stripCompressionExt,
	suggestArchiveName
} from './detect.js';
import { gzipSync, zipSync, strToU8 } from 'fflate';

describe('detectFormatFromBytes', () => {
	it('sniffs gzip', () => {
		const gz = gzipSync(strToU8('hello compress'));
		expect(detectFormatFromBytes(gz)?.codec).toBe('gzip');
	});

	it('sniffs zip', () => {
		const zipped = zipSync({ 'a.txt': strToU8('a') });
		expect(detectFormatFromBytes(zipped)?.codec).toBe('zip');
	});

	it('sniffs zstd / xz / bzip2 / lz4 magic', () => {
		expect(detectFormatFromBytes(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00]))?.codec).toBe(
			'zstd'
		);
		expect(detectFormatFromBytes(new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))?.codec).toBe(
			'xz'
		);
		expect(detectFormatFromBytes(new Uint8Array([0x42, 0x5a, 0x68, 0x39]))?.codec).toBe('bzip2');
		expect(detectFormatFromBytes(new Uint8Array([0x04, 0x22, 0x4d, 0x18, 0x00]))?.codec).toBe('lz4');
	});

	it('returns null for headerless payloads', () => {
		expect(detectFormatFromBytes(new TextEncoder().encode('not compressed'))).toBeNull();
	});
});

describe('detectFormatFromName', () => {
	it('maps common suffixes', () => {
		expect(detectFormatFromName('photo.jpg.gz')?.codec).toBe('gzip');
		expect(detectFormatFromName('bundle.tar.gz')?.codec).toBe('gzip');
		expect(detectFormatFromName('pack.zip')?.codec).toBe('zip');
		expect(detectFormatFromName('x.zst')?.codec).toBe('zstd');
		expect(detectFormatFromName('plain.txt')).toBeNull();
	});
});

describe('detectFormat', () => {
	it('prefers magic over the filename', () => {
		const gz = gzipSync(strToU8('payload'));
		expect(detectFormat(gz, 'misnamed.zip')?.codec).toBe('gzip');
	});
});

describe('names', () => {
	it('strips the codec suffix', () => {
		expect(stripCompressionExt('note.txt.gz', 'gzip')).toBe('note.txt');
		expect(stripCompressionExt('logs.tgz', 'gzip')).toBe('logs.tar');
		expect(stripCompressionExt('pack.zip', 'zip')).toBe('pack');
		expect(extensionForCodec('brotli')).toBe('.br');
	});

	it('names a zip from one file or a fallback', () => {
		expect(suggestArchiveName([{ name: 'readme.md' }])).toBe('readme.zip');
		expect(suggestArchiveName([{ name: 'a' }, { name: 'b' }])).toBe('archive.zip');
	});
});
