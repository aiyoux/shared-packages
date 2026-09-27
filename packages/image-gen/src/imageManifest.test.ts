import { describe, expect, it } from 'vitest';
import {
	formatModelBytes,
	manifestCovers,
	manifestFor,
	modelFolderKey,
	modelFolderSegments,
	parseManifest,
	sizeMatches,
	storedName,
	MANIFEST_CATALOG_VERSION
} from './imageManifest.js';
import type { ImageModelDef } from './imageModels.js';

const DEF: ImageModelDef = {
	id: 'sd-turbo',
	engine: 'sd-turbo',
	task: 't2i',
	repo: 'schmuell/sd-turbo-ort-web',
	revision: 'main',
	dtype: 'fp32',
	files: [{ path: 'unet/model.onnx', bytes: 10 }],
	sizeBytes: 10,
	resolution: 512,
	crossAttentionDim: 1024,
	vaeScale: 0.18215,
	license: 'stability-ai-community',
	languages: ['en']
};

describe('imageManifest', () => {
	it('segments folders under the image root', () => {
		expect(modelFolderSegments(DEF)).toEqual(['Image Models', 'sd-turbo', 'sd-turbo']);
		expect(modelFolderKey(DEF)).toBe('Image Models/sd-turbo/sd-turbo');
	});

	it('maps repo paths to flat basenames', () => {
		expect(storedName('unet/model.onnx')).toBe('model.onnx');
		expect(storedName('model.onnx')).toBe('model.onnx');
	});

	it('round-trips a manifest and rejects foreign shapes', () => {
		const manifest = manifestFor(
			DEF,
			[{ path: 'unet/model.onnx', name: 'model.onnx', bytes: 10, sourceUrl: 'https://x' }],
			{ origin: 'downloaded' }
		);
		const bytes = new TextEncoder().encode(JSON.stringify(manifest));
		expect(parseManifest(bytes, 'sd-turbo')?.origin).toBe('downloaded');
		expect(parseManifest(bytes, 'other')).toBeNull();
		expect(parseManifest(new TextEncoder().encode('nope'), 'sd-turbo')).toBeNull();
		expect(
			parseManifest(
				new TextEncoder().encode(JSON.stringify({ ...manifest, catalogVersion: 999 })),
				'sd-turbo'
			)
		).toBeNull();
		expect(MANIFEST_CATALOG_VERSION).toBe(1);
	});

	it('checks sizes and coverage', () => {
		expect(sizeMatches(10, 10)).toBe(true);
		expect(sizeMatches(9, 10)).toBe(false);
		expect(sizeMatches(5, undefined)).toBe(true);
		expect(sizeMatches(undefined, undefined)).toBe(false);
		expect(manifestCovers(DEF, ['model.onnx'])).toBe(true);
		expect(manifestCovers(DEF, ['other.bin'])).toBe(false);
	});

	it('formats byte sizes', () => {
		expect(formatModelBytes(500)).toBe('500 B');
		expect(formatModelBytes(2048)).toBe('2 KB');
		expect(formatModelBytes(5 * 1024 ** 2)).toBe('5.0 MB');
		expect(formatModelBytes(2.5 * 1024 ** 3)).toBe('2.5 GB');
	});
});
