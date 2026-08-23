import { describe, expect, it } from 'vitest';
import { diskPct, memPct, type HostSnapshot } from './types.js';
import { samplesToPoints } from './sparkline.js';

describe('host metrics', () => {
	it('computes mem and disk percents', () => {
		const s: HostSnapshot = {
			cpu_pct: 10,
			mem_used: 25,
			mem_total: 100,
			disks: [
				{ name: '/', used: 20, total: 80 },
				{ name: '/data', used: 10, total: 20 }
			]
		};
		expect(memPct(s)).toBe(25);
		expect(diskPct(s)).toBe(30);
	});

	it('builds sparkline points', () => {
		expect(samplesToPoints([], 100, 24)).toBe('');
		expect(samplesToPoints([0, 100], 100, 24)).toBe('0.00,24.00 100.00,0.00');
	});
});
