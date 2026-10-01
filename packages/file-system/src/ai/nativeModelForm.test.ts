import { describe, expect, it } from 'vitest';
import { canConfigureNativeTask, nativeModelFormInput, nativeModelLibraryPrefill, nativeModelTaskPrefill } from './nativeModelForm.js';
import type { AiLibraryEntry } from './library.js';

describe('native model setup', () => {
	it.each(['chat', 'text-to-speech', 'image-generation', 'transcription'] as const)('opens empty %s setup with clean runtime fields', (task) => {
		expect(canConfigureNativeTask(task)).toBe(true);
		expect(nativeModelTaskPrefill(task)).toEqual({ name: '', task, model: '', binary: '', backend: '', device: 'cpu' });
	});
	it.each(['video-upscale', 'video-interpolate', 'audio-upsampling', 'classify', 'toString'])('does not offer unsupported native registration for %s', (task) => {
		expect(canConfigureNativeTask(task)).toBe(false);
	});
	it.each(['chat', 'text-to-speech', 'image-generation', 'transcription'] as const)(
		'preserves the %s library task and clears runtime fields', (task) => {
			const entry: AiLibraryEntry = { id: 'model', name: 'A model', task, runtime: 'runtime', fileName: 'weights.onnx', url: '', sizeBytes: 1, license: '', licenseUrl: '', installedPath: '/models/weights.onnx' };
			expect(nativeModelLibraryPrefill(entry)).toEqual({ name: 'A model', task, model: '/models/weights.onnx', binary: '', backend: '', device: 'cpu' });
		}
	);
	it.each(['chat', 'text-to-speech', 'transcription'] as const)('drops a stale image backend for %s', (task) => {
		expect(nativeModelFormInput({ name: ' model ', binary: ' /bin/runtime ', model: ' /weights ', task, device: 'cpu', backend: 'cuda0' })).toEqual({ name: 'model', binary: '/bin/runtime', model: '/weights', task, device: 'cpu' });
	});
	it('keeps an explicitly selected image backend', () => {
		expect(nativeModelFormInput({ name: 'image', binary: '/bin/sd-cli', model: '/weights', task: 'image-generation', device: 'gpu', backend: ' cuda0 ' }).backend).toBe('cuda0');
	});
});
