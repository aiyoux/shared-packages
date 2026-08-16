import { describe, expect, it } from 'vitest';
import { parsePalette, suggestSvgName, VTRACER_PRESETS } from './types.js';

describe('vectorize helpers', () => {
	it('parses mixed palette tokens', () => {
		expect(parsePalette('#112233, 445566\n#aabbcc')).toEqual([
			'#112233',
			'#445566',
			'#aabbcc'
		]);
	});

	it('rewrites the source name to .svg', () => {
		expect(suggestSvgName('logo.PNG')).toBe('logo.svg');
		expect(suggestSvgName('plain')).toBe('plain.svg');
	});

	it('photo preset raises speckle and gradient step', () => {
		expect(VTRACER_PRESETS.photo.filterSpeckle).toBe(10);
		expect(VTRACER_PRESETS.photo.layerDifference).toBe(48);
		expect(VTRACER_PRESETS.bw.clustering).toBe('bw');
	});
});
