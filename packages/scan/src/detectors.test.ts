import { describe, expect, it } from 'vitest';
import {
	DEFAULT_DETECTOR,
	SCAN_DETECTOR_ORDER,
	SCAN_DETECTORS,
	resolveDetectorId
} from './detectors.js';

describe('scan detector registry', () => {
	it('covers every ordered id exactly once', () => {
		expect([...SCAN_DETECTOR_ORDER].sort()).toEqual(Object.keys(SCAN_DETECTORS).sort());
		expect(new Set(SCAN_DETECTOR_ORDER).size).toBe(SCAN_DETECTOR_ORDER.length);
	});

	it('defaults to the bundled classical backend', () => {
		expect(DEFAULT_DETECTOR).toBe('opencv');
		expect(SCAN_DETECTORS.opencv.needsModelUrl).toBe(false);
	});

	it('documents runtime, license, and weight provenance for every option', () => {
		for (const meta of Object.values(SCAN_DETECTORS)) {
			expect(meta.label.length).toBeGreaterThan(0);
			expect(meta.runtime.length).toBeGreaterThan(0);
			expect(meta.license.length).toBeGreaterThan(0);
			expect(meta.docsUrl.startsWith('https://')).toBe(true);
			expect(meta.weightHint.length).toBeGreaterThan(0);
		}
	});

	it('invents no weight URLs', () => {
		for (const meta of Object.values(SCAN_DETECTORS)) {
			expect(meta.defaultModelUrl ?? '').toBe('');
		}
	});

	it('keeps learned detectors gated on a configured model URL, except scanic', () => {
		expect(SCAN_DETECTORS.scanic.needsModelUrl).toBe(false);
		expect(SCAN_DETECTORS.docquad.needsModelUrl).toBe(true);
		expect(SCAN_DETECTORS.docaligner.needsModelUrl).toBe(true);
		expect(SCAN_DETECTORS['yolo-pose'].needsModelUrl).toBe(true);
	});
});

describe('resolveDetectorId', () => {
	it('returns known ids unchanged', () => {
		expect(resolveDetectorId('yolo-pose')).toBe('yolo-pose');
		expect(resolveDetectorId('opencv')).toBe('opencv');
	});

	it('repairs unknown or missing choices to the default', () => {
		expect(resolveDetectorId('yolov9-doc')).toBe('opencv');
		expect(resolveDetectorId(null)).toBe('opencv');
		expect(resolveDetectorId(undefined)).toBe('opencv');
		expect(resolveDetectorId(42)).toBe('opencv');
	});
});
