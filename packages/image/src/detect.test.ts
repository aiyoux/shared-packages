import { describe, expect, it } from 'vitest';
import {
	detectFormat,
	detectFormatFromBytes,
	detectFormatFromName,
	suggestOutputName
} from './detect.js';

describe('detectFormatFromBytes', () => {
	it('sniffs jpeg', () => {
		expect(detectFormatFromBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.format).toBe('jpeg');
	});

	it('sniffs png', () => {
		expect(detectFormatFromBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.format).toBe(
			'png'
		);
	});

	it('sniffs webp', () => {
		const bytes = new Uint8Array(12);
		bytes.set([0x52, 0x49, 0x46, 0x46], 0);
		bytes.set([0x57, 0x45, 0x42, 0x50], 8);
		expect(detectFormatFromBytes(bytes)?.format).toBe('webp');
	});

	it('returns null for unknown payloads', () => {
		expect(detectFormatFromBytes(new TextEncoder().encode('not an image'))).toBeNull();
	});
});

describe('detectFormatFromName', () => {
	it('maps common suffixes', () => {
		expect(detectFormatFromName('photo.JPEG')?.format).toBe('jpeg');
		expect(detectFormatFromName('shot.png')?.format).toBe('png');
		expect(detectFormatFromName('a.webp')?.format).toBe('webp');
	});
});

describe('detectFormat', () => {
	it('prefers magic over the file name', () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(detectFormat(png, 'lie.jpg')?.format).toBe('png');
	});
});

describe('suggestOutputName', () => {
	it('swaps the extension', () => {
		expect(suggestOutputName('holiday.jpeg', 'webp')).toBe('holiday.webp');
		expect(suggestOutputName('holiday', 'png')).toBe('holiday.png');
	});
});
