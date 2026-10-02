import { describe, expect, it } from 'vitest';
import {
	IMAGE_MODEL_CATALOG,
	hfImageResolveUrl,
	imageBrowserModel,
	imageModelDef
} from './imageModels.js';

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

	it('pins every file to a revision with a size and Blake3', () => {
		for (const def of IMAGE_MODEL_CATALOG) {
			expect(def.revision).toMatch(/^[a-f0-9]{40}$/);
			for (const f of def.files) {
				expect(f.bytes).toBeGreaterThan(0);
				expect(f.blake3).toMatch(/^[a-f0-9]{64}$/);
			}
		}
	});

	it('builds pinned HF resolve URLs', () => {
		const def = imageModelDef('sd-turbo');
		expect(hfImageResolveUrl(def, 'unet/model.onnx')).toBe(
			`https://huggingface.co/schmuell/sd-turbo-ort-web/resolve/${def.revision}/unet/model.onnx`
		);
	});

	it('derives one namespaced store model per def', () => {
		for (const def of IMAGE_MODEL_CATALOG) {
			const model = imageBrowserModel(def);
			expect(model.id).toBe(`image:${def.id}`);
			expect(model.files.map((f) => f.path)).toEqual(def.files.map((f) => f.path));
			expect(imageBrowserModel(def)).toBe(model);
		}
	});
});
