import { describe, expect, it } from 'vitest';
import { formatTimecode } from './time.js';
import { parseBitrate } from './process.js';

describe('formatTimecode', () => {
	it('formats minutes and seconds', () => {
		expect(formatTimecode(0)).toBe('0:00');
		expect(formatTimecode(65)).toBe('1:05');
	});

	it('optionally includes centiseconds', () => {
		expect(formatTimecode(1.25, true)).toBe('0:01.25');
	});
});

describe('parseBitrate', () => {
	it('parses k/M/G suffixes', () => {
		expect(parseBitrate('500k')).toBe(500_000);
		expect(parseBitrate('1M')).toBe(1_000_000);
		expect(parseBitrate('2G')).toBe(2_000_000_000);
		expect(parseBitrate('bogus')).toBe(1_000_000);
	});
});
