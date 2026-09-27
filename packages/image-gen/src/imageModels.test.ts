import { describe, expect, it } from 'vitest';
import {
	IMAGE_MODEL_CATALOG,
	hfImageResolveUrl,
	imageModelDef
} from './imageModels.js';
import { manifestCovers, storedName } from './imageManifest.js';

describe('image model catalog', () => {
	it('resolves known ids and rejects unknown ones', () => {
		expect(imageModelDef('sd-turbo').repo).toContain('sd-turbo');
		expect(() => imageModelDef('nope')).toThrow(/Unknown image model/);
	});

	it('gives every model unique repo paths (files store nested)', () => {
		for (const def of IMAGE_MODEL_CATALOG) {
			const paths = def.files.map((f) => f.path);
			expect(new Set(paths).size).toBe(paths.length);
		}
	});

	it('lists positive sizes that roughly cover sizeBytes', () => {
		for (const def of IMAGE_MODEL_CATALOG) {
			const known = def.files.filter((f) => f.bytes != null);
			expect(known.length).toBeGreaterThan(0);
			for (const f of known) expect(f.bytes!).toBeGreaterThan(0);
			const sum = known.reduce((n, f) => n + (f.bytes ?? 0), 0);
			expect(sum).toBeLessThanOrEqual(def.sizeBytes);
			expect(sum).toBeGreaterThan(def.sizeBytes * 0.5);
		}
	});

	it('builds stable HF resolve URLs', () => {
		expect(hfImageResolveUrl(imageModelDef('sd-turbo'), 'unet/model.onnx')).toBe(
			'https://huggingface.co/schmuell/sd-turbo-ort-web/resolve/main/unet/model.onnx'
		);
	});

	it('covers its own file lists by basename', () => {
		for (const def of IMAGE_MODEL_CATALOG) {
			expect(
				manifestCovers(def, def.files.map((f) => storedName(f.path)))
			).toBe(true);
		}
	});
});
