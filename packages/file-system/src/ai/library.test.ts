import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addAiNativeModel, listAiNativeModels } from './library.js';
const request = vi.hoisted(() => vi.fn());
vi.mock('./catalog.js', () => ({ aiMonitorRequest: request }));

beforeEach(() => request.mockReset());
const json = (value: unknown) => new Response(JSON.stringify(value));
const row = { id: 'klein', name: 'Klein', task: 'image-generation' as const, device: 'gpu' as const, binary: '/bin/sd-cli', model: '/models/klein.gguf', backend: 'metal', source: 'managed' };
const emptyComponents = { vae: null, textEncoder: null, width: null, height: null };

describe('native Klein model registration client', () => {
	it.each(['4b', '9b'] as const)('sends and reads the %s configuration', async (variant) => {
		const flux2 = { variant, vae: '/models/vae.safetensors', llm: '/models/qwen.gguf' };
		request.mockResolvedValue(json({ model: { ...row, flux2 } }));
		const { source, ...input } = row;
		expect(await addAiNativeModel('https://monitor.test', { ...input, flux2 })).toEqual({ ...row, ...emptyComponents, flux2 });
		expect(JSON.parse(request.mock.calls[0][2].body)).toEqual({ ...input, flux2 });
		request.mockResolvedValue(json({ models: [{ ...row, flux2 }] }));
		expect(await listAiNativeModels('https://monitor.test')).toEqual([{ ...row, ...emptyComponents, flux2 }]);
	});
	it('accepts legacy single-checkpoint rows and excludes unreadable Klein configurations', async () => {
		request.mockResolvedValue(json({ models: [row, { ...row, flux2: { variant: 'dev' } }, { ...row, flux2: { variant: '4b', vae: '/vae' } }] }));
		expect(await listAiNativeModels('https://monitor.test')).toEqual([{ ...row, ...emptyComponents, flux2: null }]);
	});
	it('reads component paths and resolution from newer monitors', async () => {
		const components = { vae: '/models/vae.safetensors', textEncoder: '/models/llm.gguf', width: 1024, height: 768 };
		request.mockResolvedValue(json({ models: [{ ...row, ...components }] }));
		expect(await listAiNativeModels('https://monitor.test')).toEqual([{ ...row, ...components, flux2: null }]);
	});
});
