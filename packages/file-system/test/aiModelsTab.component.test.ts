import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@testing-library/svelte';
import AiModelsTab from '../src/ui/AiModelsTab.svelte';
import type { AiModelSection } from '../src/ai/modelRegistry.js';

const mocks = vi.hoisted(() => ({
	sections: [] as AiModelSection[],
	addNative: vi.fn(async () => ({})),
	selections: vi.fn(async () => ({ v: 3, tasks: {} })),
	profiles: vi.fn(), meta: vi.fn()
}));
vi.mock('../src/ai/index.js', () => ({
	listAiLibrarySources: () => ({ sections: mocks.sections, surfaces: [{ task: 'image-generation', appId: 'generate', label: 'Generate' }] }),
	getAiSelectionMap: mocks.selections,
	resolveAiModelRef: () => null,
	setAiModelRef: vi.fn(),
	subscribeAiSelection: () => () => {},
	normalizeAiBaseUrl: (url: string) => url,
	listAiModels: async () => ({ models: [], errors: [] }),
	listAiProfiles: async () => ({ profiles: [] }),
	listAiLibrary: async () => ({ dir: '/models', entries: [] }),
	listAiNativeModels: async () => [],
	addAiNativeModel: mocks.addNative,
	deleteAiProfile: vi.fn(), deleteAiNativeModel: vi.fn(),
	installAiLibraryModel: vi.fn(), installAiProfile: vi.fn(),
	removeAiLibraryModel: vi.fn(), validateAiProfileInput: () => null
}));
vi.mock('../src/monitor/credentials.js', () => ({
	listProfiles: mocks.profiles
}));
vi.mock('../src/monitor/client.js', () => ({ createMonitorClient: () => ({ meta: mocks.meta }) }));
vi.mock('../src/services/monitorLink.js', () => ({ getMonitorLink: async () => ({ status: () => ({ state: 'reachable', jobs: true }), subscribe: () => () => {} }) }));
vi.mock('../src/ai/browserHost.js', () => ({ browserAiHost: () => ({ host: null, models: {}, subscribe: () => () => {} }) }));
vi.mock('@shared-packages/ui', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.profiles.mockResolvedValue([{ id: 'desktop', name: 'Desktop', baseUrl: 'http://monitor:8300' }]);
	mocks.meta.mockResolvedValue({ capabilities: { ai: { chat: true, nativeFlux2: true } } });
	mocks.sections = [
		{ id: 'chat', task: 'chat', title: 'Chat', models: async () => [] },
		{ id: 'transcription', task: 'transcription', title: 'Speech recognition', models: async () => [] },
		{ id: 'text-to-speech', task: 'text-to-speech', title: 'Speech synthesis', models: async () => [] },
		{ id: 'image-generation', task: 'image-generation', title: 'Image generation', models: async () => [] },
		...(['video-upscale', 'video-interpolate', 'audio-upsampling'] as const).map((task) => ({
			id: task, task, title: task,
			models: async () => [{ ref: { location: 'monitor-native' as const, modelId: task, sourceId: 'tools', variantId: 'cpu', monitorProfileId: 'desktop' }, label: task, status: 'not-installed' as const, sizeBytes: null }]
		}))
	];
});

describe('Monitor model category discovery', () => {
	it.each(['4b', '9b'] as const)('registers Klein %s with its matching Qwen3 encoder and Metal backend', async (variant) => {
		render(AiModelsTab);
		const images = await screen.findByTestId('ai-lib-section-image-generation-desktop');
		images.setAttribute('open', '');
		await fireEvent.click(screen.getByTestId('ai-monitor-configure-image-generation-desktop'));
		await fireEvent.change(screen.getByTestId('monitor-ai-image-model'), { target: { value: variant } });
		const encoder = variant === '4b' ? '4B' : '8B';
		expect(screen.getByTestId('monitor-ai-add-model').textContent).toContain(`Qwen3 ${encoder} text encoder`);
		expect(screen.getByTestId('monitor-ai-model-llm').getAttribute('placeholder')).toContain(`Qwen3-${encoder}`);
		await fireEvent.input(screen.getByTestId('monitor-ai-model-binary'), { target: { value: '/bin/sd-cli' } });
		await fireEvent.input(screen.getByTestId('monitor-ai-model-file'), { target: { value: `/models/klein-${variant}.gguf` } });
		await fireEvent.input(screen.getByTestId('monitor-ai-model-vae'), { target: { value: '/models/flux2_ae.safetensors' } });
		await fireEvent.input(screen.getByTestId('monitor-ai-model-llm'), { target: { value: `/models/qwen-${encoder}.gguf` } });
		await fireEvent.change(screen.getByTestId('monitor-ai-model-device'), { target: { value: 'gpu' } });
		await fireEvent.input(screen.getByTestId('monitor-ai-model-backend'), { target: { value: 'metal' } });
		await waitFor(() => expect((screen.getByTestId('monitor-ai-model-save') as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(screen.getByTestId('monitor-ai-model-save'));
		await waitFor(() => expect(mocks.addNative).toHaveBeenCalledWith('http://monitor:8300', {
			name: `FLUX.2 Klein ${variant.toUpperCase()}`, task: 'image-generation', device: 'gpu',
			binary: '/bin/sd-cli', model: `/models/klein-${variant}.gguf`, backend: 'metal',
			flux2: { variant, vae: '/models/flux2_ae.safetensors', llm: `/models/qwen-${encoder}.gguf` },
		}));
	});

	it('registers Qwen-Image-2.1 with its components and a chosen resolution', async () => {
		mocks.meta.mockResolvedValue({ capabilities: { ai: { chat: true, nativeImageComponents: true } } });
		render(AiModelsTab);
		const images = await screen.findByTestId('ai-lib-section-image-generation-desktop');
		images.setAttribute('open', '');
		await fireEvent.click(screen.getByTestId('ai-monitor-configure-image-generation-desktop'));
		await fireEvent.change(screen.getByTestId('monitor-ai-image-model'), { target: { value: 'qwen-image' } });
		expect(screen.getByTestId('monitor-ai-add-model').textContent).toContain('Qwen3-VL 8B text encoder');
		expect((screen.getByTestId('monitor-ai-model-width') as HTMLInputElement).value).toBe('1024');
		expect((screen.getByTestId('monitor-ai-model-height') as HTMLInputElement).value).toBe('1024');
		expect(screen.getByTestId('monitor-ai-model-vae').getAttribute('placeholder')).toContain('qwen_image_2.1_vae_bf16');
		await waitFor(() => expect(screen.queryByTestId('monitor-ai-qwen-update')).toBeNull());
		await fireEvent.input(screen.getByTestId('monitor-ai-model-binary'), { target: { value: '/bin/sd-cli' } });
		await fireEvent.input(screen.getByTestId('monitor-ai-model-file'), { target: { value: '/models/qwen-image.gguf' } });
		await fireEvent.input(screen.getByTestId('monitor-ai-model-vae'), { target: { value: '/models/vae.safetensors' } });
		await fireEvent.input(screen.getByTestId('monitor-ai-model-llm'), { target: { value: '/models/qwen3vl.gguf' } });
		await fireEvent.input(screen.getByTestId('monitor-ai-model-width'), { target: { value: '1024' } });
		await fireEvent.input(screen.getByTestId('monitor-ai-model-height'), { target: { value: '1024' } });
		await fireEvent.change(screen.getByTestId('monitor-ai-model-device'), { target: { value: 'gpu' } });
		await fireEvent.click(screen.getByTestId('monitor-ai-model-save'));
		await waitFor(() => expect(mocks.addNative).toHaveBeenCalledWith('http://monitor:8300', {
			name: 'Qwen-Image-2.1', task: 'image-generation', device: 'gpu',
			binary: '/bin/sd-cli', model: '/models/qwen-image.gguf',
			vae: '/models/vae.safetensors', textEncoder: '/models/qwen3vl.gguf',
			width: 1024, height: 1024
		}));
	});

	it('gates Qwen-Image-2.1 on an older Monitor and rejects bad resolution', async () => {
		mocks.meta.mockResolvedValue({ capabilities: { ai: { chat: true } } });
		render(AiModelsTab);
		const images = await screen.findByTestId('ai-lib-section-image-generation-desktop');
		images.setAttribute('open', '');
		await fireEvent.click(screen.getByTestId('ai-monitor-configure-image-generation-desktop'));
		await fireEvent.change(screen.getByTestId('monitor-ai-image-model'), { target: { value: 'qwen-image' } });
		await screen.findByTestId('monitor-ai-qwen-update');
		expect((screen.getByTestId('monitor-ai-model-save') as HTMLButtonElement).disabled).toBe(true);
		mocks.meta.mockResolvedValue({ capabilities: { ai: { chat: true, nativeImageComponents: true } } });
		await fireEvent.click(screen.getByTestId('monitor-ai-check'));
		await waitFor(() => expect(screen.queryByTestId('monitor-ai-qwen-update')).toBeNull());
		await fireEvent.input(screen.getByTestId('monitor-ai-model-binary'), { target: { value: '/bin/sd-cli' } });
		await fireEvent.input(screen.getByTestId('monitor-ai-model-file'), { target: { value: '/models/qwen-image.gguf' } });
		await fireEvent.input(screen.getByTestId('monitor-ai-model-vae'), { target: { value: '/models/vae.safetensors' } });
		await fireEvent.input(screen.getByTestId('monitor-ai-model-llm'), { target: { value: '/models/qwen3vl.gguf' } });
		await fireEvent.input(screen.getByTestId('monitor-ai-model-width'), { target: { value: '64' } });
		await fireEvent.click(screen.getByTestId('monitor-ai-model-save'));
		expect(screen.getByTestId('monitor-ai-model-error').textContent).toContain('128–2048');
		expect(mocks.addNative).not.toHaveBeenCalled();
	});

	it('keeps Klein discoverable on an older Monitor and enables it after an upgrade', async () => {
		mocks.meta.mockResolvedValue({ capabilities: { ai: { chat: true } } });
		render(AiModelsTab);
		const images = await screen.findByTestId('ai-lib-section-image-generation-desktop');
		images.setAttribute('open', '');
		await fireEvent.click(screen.getByTestId('ai-monitor-configure-image-generation-desktop'));
		await fireEvent.change(screen.getByTestId('monitor-ai-image-model'), { target: { value: '9b' } });
		await screen.findByTestId('monitor-ai-flux2-update');
		expect((screen.getByTestId('monitor-ai-model-save') as HTMLButtonElement).disabled).toBe(true);
		expect(mocks.addNative).not.toHaveBeenCalled();
		mocks.meta.mockResolvedValue({ capabilities: { ai: { chat: true, nativeFlux2: true } } });
		await fireEvent.click(screen.getByTestId('monitor-ai-check'));
		await waitFor(() => expect(screen.queryByTestId('monitor-ai-flux2-update')).toBeNull());
		expect((screen.getByTestId('monitor-ai-model-save') as HTMLButtonElement).disabled).toBe(false);
	});

	it('requires Klein companion paths and clears incompatible weights when switching models', async () => {
		render(AiModelsTab);
		const images = await screen.findByTestId('ai-lib-section-image-generation-desktop');
		images.setAttribute('open', '');
		await fireEvent.click(screen.getByTestId('ai-monitor-configure-image-generation-desktop'));
		await fireEvent.change(screen.getByTestId('monitor-ai-image-model'), { target: { value: '4b' } });
		await fireEvent.input(screen.getByTestId('monitor-ai-model-binary'), { target: { value: '/bin/sd-cli' } });
		await fireEvent.input(screen.getByTestId('monitor-ai-model-file'), { target: { value: '/models/klein-4b.gguf' } });
		await waitFor(() => expect((screen.getByTestId('monitor-ai-model-save') as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(screen.getByTestId('monitor-ai-model-save'));
		expect(screen.getByTestId('monitor-ai-model-error').textContent).toContain('matching Qwen3');
		expect(mocks.addNative).not.toHaveBeenCalled();
		await fireEvent.input(screen.getByTestId('monitor-ai-model-llm'), { target: { value: '/models/qwen-4b.gguf' } });
		await fireEvent.change(screen.getByTestId('monitor-ai-image-model'), { target: { value: '9b' } });
		expect((screen.getByTestId('monitor-ai-model-file') as HTMLInputElement).value).toBe('');
		expect((screen.getByTestId('monitor-ai-model-llm') as HTMLInputElement).value).toBe('');
		expect((screen.getByTestId('monitor-ai-model-name') as HTMLInputElement).value).toBe('FLUX.2 Klein 9B');
	});

	it('shows all four native tasks beside tools even with no configured AI models, without adding fake defaults', async () => {
		render(AiModelsTab);
		for (const task of ['chat', 'transcription', 'text-to-speech', 'image-generation']) {
			const section = await screen.findByTestId(`ai-lib-section-${task}-desktop`);
			section.setAttribute('open', '');
			await waitFor(() => expect(screen.getByTestId(`ai-monitor-empty-${task}-desktop`).textContent).toContain('No model configured'));
			expect(screen.getByTestId(`ai-monitor-configure-${task}-desktop`)).toBeDefined();
		}
		for (const task of ['video-upscale', 'video-interpolate', 'audio-upsampling']) {
			expect(screen.getByTestId(`ai-lib-section-${task}-desktop`)).toBeDefined();
			expect(screen.queryByTestId(`ai-monitor-configure-${task}-desktop`)).toBeNull();
		}
		expect(screen.getByTestId('ai-default-image-generation-generate').querySelectorAll('option')).toHaveLength(1);
	});

	it('shows unconfigured API tasks and opens API credentials setup without pretending media editing exists', async () => {
		render(AiModelsTab);
		for (const task of ['chat', 'transcription', 'text-to-speech', 'image-generation']) {
			const section = await screen.findByTestId(`ai-lib-section-${task}-desktop-api`);
			section.setAttribute('open', '');
			await screen.findByTestId(`ai-provider-empty-${task}-desktop`);
		}
		await fireEvent.click(screen.getByRole('button', { name: 'Configure Image generation API' }));
		expect(screen.getByTestId('monitor-ai-install')).toBeDefined();
		expect(screen.getByTestId('ai-lib-section-image-generation-desktop-api').textContent).toContain('Media model editing is not yet available here');
		expect(screen.getByTestId('ai-default-image-generation-generate').querySelectorAll('option')).toHaveLength(1);
	});

	it('explains image setup before configuration and updates guidance when the task changes', async () => {
		render(AiModelsTab);
		const images = await screen.findByTestId('ai-lib-section-image-generation-desktop');
		images.setAttribute('open', '');
		expect(images.textContent).toContain('sd-cli --list-devices');
		expect(images.textContent).toContain('complete checkpoint');
		expect(images.textContent).toContain('Browser SDXS/SD-Turbo ONNX installations are separate');
		expect(images.querySelector('a[href="https://github.com/leejet/stable-diffusion.cpp"]')).toBeTruthy();
		await fireEvent.click(screen.getByTestId('ai-monitor-configure-image-generation-desktop'));
		const form = screen.getByTestId('monitor-ai-add-model');
		expect(form.textContent).toContain('/usr/local/bin/sd-cli');
		await fireEvent.change(screen.getByTestId('monitor-ai-model-task'), { target: { value: 'text-to-speech' } });
		expect(form.textContent).toContain('.onnx.json');
		expect(form.textContent).not.toContain('complete checkpoint');
	});

	it('keeps every Monitor feature and setup guide visible when the Monitor probe and catalogs fail', async () => {
		mocks.meta.mockRejectedValue(new Error('Monitor unreachable'));
		mocks.sections = mocks.sections.map((section) => ({ ...section, models: async () => { throw new Error('Catalog unreachable'); } }));
		render(AiModelsTab);
		await screen.findByTestId('monitor-ai-unsupported');
		for (const task of ['chat', 'transcription', 'text-to-speech', 'image-generation', 'video-upscale', 'video-interpolate', 'audio-upsampling']) {
			const section = screen.getByTestId(`ai-lib-section-${task}-desktop`);
			section.setAttribute('open', '');
			expect(section.querySelector(`[data-testid="monitor-setup-native-${task}"]`)).toBeTruthy();
		}
		await fireEvent.click(screen.getByTestId('ai-monitor-configure-image-generation-desktop'));
		expect((screen.getByTestId('monitor-ai-model-save') as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByTestId('monitor-ai-check') as HTMLButtonElement).disabled).toBe(false);
		expect(screen.getByTestId('monitor-ai-downloads').textContent).toContain('Refresh to load');
		await fireEvent.click(screen.getByRole('button', { name: 'Configure Image generation API' }));
		expect((screen.getByTestId('monitor-ai-install-save') as HTMLButtonElement).disabled).toBe(true);
		expect(mocks.addNative).not.toHaveBeenCalled();
	});

	it('shows Monitor features and manual setup before a device has been added', async () => {
		mocks.profiles.mockResolvedValue([]);
		render(AiModelsTab);
		for (const task of ['chat', 'transcription', 'text-to-speech', 'image-generation', 'video-upscale', 'video-interpolate', 'audio-upsampling']) {
			await screen.findByTestId(`ai-monitor-discovery-${task}`);
		}
		expect(screen.getByTestId('monitor-setup-api-text-to-speech').textContent).toContain('voice = "your-provider-voice-id"');
		expect(screen.getByTestId('monitor-setup-api-image-generation').textContent).toContain('[[ai.media_models]]');
		expect(screen.getByTestId('ai-default-image-generation-generate').querySelectorAll('option')).toHaveLength(1);
	});

	it('keeps all Monitor task guides in a standalone host with no registered browser catalog', async () => {
		mocks.sections = [];
		render(AiModelsTab);
		const images = await screen.findByTestId('ai-lib-section-image-generation-desktop');
		expect(images.textContent).toContain('This app does not provide a task model catalog');
		expect(images.textContent).not.toContain('No model configured');
		expect(screen.getByTestId('ai-lib-section-video-interpolate-desktop')).toBeDefined();
		expect(screen.getByTestId('ai-lib-section-audio-upsampling-desktop')).toBeDefined();
		expect(screen.getByTestId('ai-default-image-generation-generate').querySelectorAll('option')).toHaveLength(1);
	});

	it('opens clean task-specific setup and submits the chosen task', async () => {
		render(AiModelsTab);
		const images = await screen.findByTestId('ai-lib-section-image-generation-desktop');
		images.setAttribute('open', '');
		await fireEvent.click(screen.getByTestId('ai-monitor-configure-image-generation-desktop'));
		const task = screen.getByTestId('monitor-ai-model-task') as HTMLSelectElement;
		expect(task.value).toBe('image-generation');
		await fireEvent.input(screen.getByTestId('monitor-ai-model-backend'), { target: { value: 'cuda0' } });
		await fireEvent.input(screen.getByTestId('monitor-ai-model-file'), { target: { value: '/models/image.safetensors' } });
		const speech = screen.getByTestId('ai-lib-section-text-to-speech-desktop');
		speech.setAttribute('open', '');
		await fireEvent.click(screen.getByTestId('ai-monitor-configure-text-to-speech-desktop'));
		expect(task.value).toBe('text-to-speech');
		expect((screen.getByTestId('monitor-ai-model-file') as HTMLInputElement).value).toBe('');
		expect(screen.getByTestId('monitor-ai-model-binary').getAttribute('placeholder')).toBe('/usr/local/bin/piper');
		await fireEvent.input(screen.getByTestId('monitor-ai-model-name'), { target: { value: 'Voice' } });
		await fireEvent.input(screen.getByTestId('monitor-ai-model-binary'), { target: { value: '/bin/piper' } });
		await fireEvent.input(screen.getByTestId('monitor-ai-model-file'), { target: { value: '/models/voice.onnx' } });
		await waitFor(() => expect((screen.getByTestId('monitor-ai-model-save') as HTMLButtonElement).disabled).toBe(false));
		await fireEvent.click(screen.getByTestId('monitor-ai-model-save'));
		await waitFor(() => expect(mocks.addNative).toHaveBeenCalledWith('http://monitor:8300', { name: 'Voice', task: 'text-to-speech', device: 'cpu', binary: '/bin/piper', model: '/models/voice.onnx' }));
	});
});
