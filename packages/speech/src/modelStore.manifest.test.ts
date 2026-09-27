import { describe, expect, it } from 'vitest';
import { KOKORO_82M, WHISPER_TINY } from './models.js';
import {
	MANIFEST_NAME,
	MODEL_STORE_ROOT_FOLDER,
	formatModelBytes,
	modelFileSizeProblem,
	manifestCovers,
	manifestFor,
	modelFolderKey,
	modelFolderSegments,
	parseManifest,
	pathSegments,
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

describe('pathSegments', () => {
	it('splits nested repo paths and leaves flat names alone', () => {
		expect(pathSegments('onnx/encoder_model_quantized.onnx')).toEqual(['onnx', 'encoder_model_quantized.onnx']);
		expect(pathSegments('config.json')).toEqual(['config.json']);
		expect(pathSegments('voices/af_heart.bin')).toEqual(['voices', 'af_heart.bin']);
	});
});

describe('manifestCovers', () => {
	it('accepts a folder whose flat basenames cover the catalog', () => {
		const names = WHISPER_TINY.files.map((f) => storedName(f.path));
		expect(manifestCovers(WHISPER_TINY, names)).toBe(true);
	});

	it('rejects when any catalog file is absent', () => {
		const names = WHISPER_TINY.files.map((f) => storedName(f.path)).slice(1);
		expect(manifestCovers(WHISPER_TINY, names)).toBe(false);
		expect(manifestCovers(WHISPER_TINY, [])).toBe(false);
	});

	it('ignores unrelated files in the folder', () => {
		const names = [...KOKORO_82M.files.map((f) => storedName(f.path)), 'manifest.json', 'notes.txt'];
		expect(manifestCovers(KOKORO_82M, names)).toBe(true);
	});
});

describe('manifest origin', () => {
	it('defaults to no origin and stamps imported when asked', () => {
		const base = manifestFor(KOKORO_82M, []);
		expect(base.origin).toBeUndefined();
		const imported = manifestFor(KOKORO_82M, [], { origin: 'imported' });
		expect(imported.origin).toBe('imported');
		// parseManifest tolerates the optional field round-tripping through JSON.
		const bytes = new TextEncoder().encode(JSON.stringify(imported));
		expect(parseManifest(bytes, 'kokoro-82m')?.origin).toBe('imported');
	});
});

describe('modelFileSizeProblem', () => {
	it('rejects an empty file (ORT would report "no graph" instead)', () => {
		expect(modelFileSizeProblem('onnx/model.onnx', 0, 325532232)).toMatch(/^model\.onnx in Files is empty/);
		expect(modelFileSizeProblem('voice.onnx', 0)).toMatch(/is empty/);
	});

	it('rejects a short file against the catalog size', () => {
		expect(modelFileSizeProblem('onnx/model.onnx', 104857600, 325532232)).toBe(
			'model.onnx in Files is 100.0 MB but should be 310.5 MB — the download or import was incomplete. Download it again and re-import it.'
		);
	});

	it('accepts the exact size, or any non-empty size when the catalog has none', () => {
		expect(modelFileSizeProblem('onnx/model.onnx', 325532232, 325532232)).toBeNull();
		expect(modelFileSizeProblem('voice.onnx', 63201294)).toBeNull();
	});
});
