import { describe, expect, it } from 'vitest';
import { canConfigureNativeTask, nativeModelFormInput, nativeModelLibraryPrefill, nativeModelTaskPrefill } from './nativeModelForm.js';
import type { AiLibraryEntry } from './library.js';

describe('native model setup', () => {
	it.each(['chat', 'text-to-speech', 'image-generation', 'transcription'] as const)('opens empty %s setup with clean runtime fields', (task) => {
		expect(canConfigureNativeTask(task)).toBe(true);
		expect(nativeModelTaskPrefill(task)).toEqual({ name: '', task, model: '', binary: '', backend: '', device: 'cpu', vae: '', textEncoder: '', width: 512, height: 512 });
	});
	it.each(['video-upscale', 'video-interpolate', 'audio-upsampling', 'classify', 'toString'])('does not offer unsupported native registration for %s', (task) => {
		expect(canConfigureNativeTask(task)).toBe(false);
	});
	it.each(['chat', 'text-to-speech', 'image-generation', 'transcription'] as const)(
		'preserves the %s library task and clears runtime fields', (task) => {
			const entry: AiLibraryEntry = { id: 'model', name: 'A model', task, runtime: 'runtime', fileName: 'weights.onnx', url: '', sizeBytes: 1, license: '', licenseUrl: '', installedPath: '/models/weights.onnx' };
			expect(nativeModelLibraryPrefill(entry)).toEqual({ name: 'A model', task, model: '/models/weights.onnx', binary: '', backend: '', device: 'cpu', vae: '', textEncoder: '', width: 512, height: 512 });
		}
	);
	it.each(['chat', 'text-to-speech', 'transcription'] as const)('drops a stale image backend for %s', (task) => {
		expect(nativeModelFormInput({ name: ' model ', binary: ' /bin/runtime ', model: ' /weights ', task, device: 'cpu', backend: 'cuda0' })).toEqual({ name: 'model', binary: '/bin/runtime', model: '/weights', task, device: 'cpu' });
	});
	it('keeps an explicitly selected image backend', () => {
		expect(nativeModelFormInput({ name: 'image', binary: '/bin/sd-cli', model: '/weights', task: 'image-generation', device: 'gpu', backend: ' cuda0 ' }).backend).toBe('cuda0');
	});
	it.each(['4b', '9b'] as const)('keeps the %s bundle, trims its paths, and drops it when the task changes', (variant) => {
		const input = { name: ' Klein ', binary: ' /bin/sd-cli ', model: ' /models/diffusion.gguf ', task: 'image-generation' as const, device: 'gpu' as const, backend: ' metal ', flux2: { variant, vae: ' /models/vae.safetensors ', llm: ' /models/qwen.gguf ' } };
		expect(nativeModelFormInput(input)).toEqual({ name: 'Klein', binary: '/bin/sd-cli', model: '/models/diffusion.gguf', task: 'image-generation', device: 'gpu', backend: 'metal', flux2: { variant, vae: '/models/vae.safetensors', llm: '/models/qwen.gguf' } });
		expect(nativeModelFormInput({ ...input, task: 'chat' })).toEqual({ name: 'Klein', binary: '/bin/sd-cli', model: '/models/diffusion.gguf', task: 'chat', device: 'gpu' });
	});
	it('keeps component paths and resolution for image rows, drops them elsewhere', () => {
		const base = { name: 'Qwen', binary: '/bin/sd-cli', model: '/models/diffusion.gguf', task: 'image-generation' as const, device: 'gpu' as const, vae: ' /models/vae.safetensors ', textEncoder: ' /models/llm.gguf ', width: 1024, height: 768 };
		expect(nativeModelFormInput(base)).toEqual({ ...base, vae: '/models/vae.safetensors', textEncoder: '/models/llm.gguf' });
		expect(nativeModelFormInput({ ...base, task: 'chat' })).toEqual({ name: 'Qwen', binary: '/bin/sd-cli', model: '/models/diffusion.gguf', task: 'chat', device: 'gpu' });
	});
	it('drops a half component pair and out-of-range resolution', () => {
		const base = { name: 'Qwen', binary: '/bin/sd-cli', model: '/models/diffusion.gguf', task: 'image-generation' as const, device: 'gpu' as const };
		expect(nativeModelFormInput({ ...base, vae: '/models/vae.safetensors', width: 64, height: 5000 })).toEqual(base);
		expect(nativeModelFormInput({ ...base, width: 513 })).toEqual(base);
	});
});


describe('OmniSVG registration', () => {
	it('trims processor paths, excludes diffusion fields and clears OmniSVG on task changes', () => {
		const input = { name: ' OmniSVG ', binary: ' /venv/bin/python ', model: ' /models/pytorch_model.bin ', task: 'image-generation' as const, device: 'gpu' as const, backend: 'metal', vae: '/vae', textEncoder: '/llm', omnisvg: { variant: '4b' as const, baseModel: ' /models/qwen ' }, width: 512, height: 512 };
		expect(nativeModelFormInput(input)).toEqual({ name: 'OmniSVG', binary: '/venv/bin/python', model: '/models/pytorch_model.bin', task: 'image-generation', device: 'gpu', omnisvg: { variant: '4b', baseModel: '/models/qwen' }, width: 512, height: 512 });
		expect(nativeModelFormInput({ ...input, task: 'chat' })).toEqual({ name: 'OmniSVG', binary: '/venv/bin/python', model: '/models/pytorch_model.bin', task: 'chat', device: 'gpu' });
	});
});
