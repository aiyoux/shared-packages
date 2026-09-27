import { describe, expect, it } from 'vitest';
import { KOKORO_82M, WHISPER_TINY } from './models.js';
import {
	MANIFEST_NAME,
	MODEL_STORE_ROOT_FOLDER,
	formatModelBytes,
	manifestFor,
	modelFolderKey,
	modelFolderSegments,
	parseManifest,
	sizeMatches,
	storedName
} from './modelStore.manifest.js';

describe('storedName', () => {
	it('takes the basename of repo paths', () => {
		expect(storedName('onnx/encoder_model_quantized.onnx')).toBe('encoder_model_quantized.onnx');
		expect(storedName('config.json')).toBe('config.json');
		expect(storedName('voices/af_heart.bin')).toBe('af_heart.bin');
	});

	it('is total for our catalogs — no basename collisions within a model', () => {
		for (const def of [WHISPER_TINY, KOKORO_82M]) {
			const names = def.files.map((f) => storedName(f.path));
			expect(new Set(names).size).toBe(names.length);
		}
	});
});

describe('manifest helpers', () => {
	it('builds and parses a manifest round-trip', () => {
		const manifest = manifestFor(WHISPER_TINY, [
			{ path: 'config.json', name: 'config.json', bytes: 2243, sourceUrl: 'https://huggingface.co/x' }
		]);
		const bytes = new TextEncoder().encode(JSON.stringify(manifest));
		const parsed = parseManifest(bytes, 'whisper-tiny');
		expect(parsed?.repo).toBe(WHISPER_TINY.repo);
		expect(parsed?.files[0]?.path).toBe('config.json');
	});

	it('rejects foreign shapes and wrong model ids', () => {
		const bytes = new TextEncoder().encode(JSON.stringify({ hello: 1 }));
		expect(parseManifest(bytes, 'whisper-tiny')).toBeNull();
		const wrong = new TextEncoder().encode(JSON.stringify({ catalogVersion: 1, modelId: 'other', repo: 'r', files: [] }));
		expect(parseManifest(wrong, 'whisper-tiny')).toBeNull();
		const broken = new TextEncoder().encode('{not json');
		expect(parseManifest(broken, 'whisper-tiny')).toBeNull();
	});
});

describe('sizeMatches', () => {
	it('accepts exact size and any size when no expectation exists', () => {
		expect(sizeMatches(1024, 1024)).toBe(true);
		expect(sizeMatches(1024, 2048)).toBe(false);
		expect(sizeMatches(7, undefined)).toBe(true);
		expect(sizeMatches(undefined, 7)).toBe(false);
	});
});

describe('folder layout', () => {
	it('places models under Speech Models/<engine>/<model>', () => {
		expect(modelFolderSegments(KOKORO_82M)).toEqual(['Speech Models', 'kokoro', 'kokoro-82m']);
		expect(modelFolderKey(KOKORO_82M)).toBe('Speech Models/kokoro/kokoro-82m');
		expect(MODEL_STORE_ROOT_FOLDER).toBe('Speech Models');
		expect(MANIFEST_NAME).toBe('manifest.json');
	});
});

describe('formatModelBytes', () => {
	it('formats the common model sizes', () => {
		expect(formatModelBytes(44_204_860)).toBe('42.2 MB');
		expect(formatModelBytes(31_949_635)).toBe('30.5 MB');
	});
});