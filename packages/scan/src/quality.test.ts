import { describe, expect, it } from 'vitest';
import { SCAN_QUALITY_ORDER, SCAN_QUALITY_PRESETS, scanQualityPreset } from './quality.ts';

describe('scan quality presets', () => {
	it('keeps High as the previous default (0.92 JPEG, 1600px edge)', () => {
		expect(scanQualityPreset(undefined)).toEqual(SCAN_QUALITY_PRESETS.high);
		expect(SCAN_QUALITY_PRESETS.high.jpeg).toBe(0.92);
		expect(SCAN_QUALITY_PRESETS.high.maxEdge).toBe(1600);
	});

	it('orders from smallest to largest', () => {
		const edges = SCAN_QUALITY_ORDER.map((id) => SCAN_QUALITY_PRESETS[id].maxEdge);
		expect(edges).toEqual([...edges].sort((a, b) => a - b));
		const jpeg = SCAN_QUALITY_ORDER.map((id) => SCAN_QUALITY_PRESETS[id].jpeg);
		expect(jpeg).toEqual([...jpeg].sort((a, b) => a - b));
	});

	it('falls back to High for an unknown id', () => {
		expect(scanQualityPreset('nope').id).toBe('high');
	});
});
