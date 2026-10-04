import { beforeEach, describe, expect, it } from 'vitest';
import {
	describeDuration,
	estimateTransferMs,
	linkBytesPerSecond,
	linkKeyOf,
	recordLinkTransfer,
	resetLinkSpeedForTest
} from './linkSpeed.js';

describe('link speed', () => {
	beforeEach(() => resetLinkSpeedForTest());

	it('is unknown until a transfer is measured', () => {
		expect(estimateTransferMs('http://127.0.0.1:8300/v1/fs/read', 1_000_000)).toBeUndefined();
	});

	it('keys by origin, so every route of one monitor shares a measurement', () => {
		recordLinkTransfer('http://127.0.0.1:8300/v1/fs/read?path=a', 1_000_000, 1000);
		expect(linkKeyOf('http://127.0.0.1:8300/v1/b2/x')).toBe('http://127.0.0.1:8300');
		expect(linkBytesPerSecond('http://127.0.0.1:8300/v1/b2/connections/c/download')).toBe(1_000_000);
		expect(linkBytesPerSecond('http://127.0.0.1:8400/v1/fs/read')).toBeUndefined();
	});

	it('ignores transfers too small to say anything about bandwidth', () => {
		recordLinkTransfer('http://h:1/', 4096, 500);
		expect(linkBytesPerSecond('http://h:1/')).toBeUndefined();
	});

	it('smooths toward recent transfers', () => {
		recordLinkTransfer('http://h:1/', 1_000_000, 1000);
		recordLinkTransfer('http://h:1/', 3_000_000, 1000);
		const bps = linkBytesPerSecond('http://h:1/')!;
		expect(bps).toBeGreaterThan(1_000_000);
		expect(bps).toBeLessThan(3_000_000);
		expect(estimateTransferMs('http://h:1/', bps)).toBeCloseTo(1000);
	});

	it('describes durations in words', () => {
		expect(describeDuration(400)).toBe('a moment');
		expect(describeDuration(40_000)).toBe('about 40 s');
		expect(describeDuration(180_000)).toBe('about 3 min');
		expect(describeDuration(2 * 3600_000)).toBe('about 2 h');
	});
});
