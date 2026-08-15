import { describe, expect, it } from 'vitest';
import { listEngines, peekEngine } from './engines.js';
import { clampQuality, DEFAULT_ENGINE, engineSupports, qualityUsesSlider } from './types.js';

describe('image engines catalog', () => {
	it('lists native and jsquash without loading WASM', () => {
		const ids = listEngines().map((e) => e.id);
		expect(ids).toEqual(['native', 'jsquash']);
		expect(peekEngine('native')).toBeNull();
		expect(peekEngine('jsquash')).toBeNull();
	});

	it('defaults to the in-browser native engine', () => {
		expect(DEFAULT_ENGINE).toBe('native');
		expect(engineSupports('native', 'jpeg')).toBe(true);
		expect(engineSupports('jsquash', 'webp')).toBe(true);
	});

	it('clamps quality and only sliders lossy formats', () => {
		expect(clampQuality(undefined)).toBe(0.8);
		expect(clampQuality(2)).toBe(1);
		expect(clampQuality(-1)).toBe(0.05);
		expect(qualityUsesSlider('jpeg')).toBe(true);
		expect(qualityUsesSlider('png')).toBe(false);
	});
});
