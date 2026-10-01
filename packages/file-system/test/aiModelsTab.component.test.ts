import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@testing-library/svelte';
import AiModelsTab from '../src/ui/AiModelsTab.svelte';
import type { AiModelSection } from '../src/ai/modelRegistry.js';

const mocks = vi.hoisted(() => ({
	sections: [] as AiModelSection[],
	addNative: vi.fn(async () => ({})),
	selections: vi.fn(async () => ({ v: 3, tasks: {} }))
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
	listProfiles: async () => [{ id: 'desktop', name: 'Desktop', baseUrl: 'http://monitor:8300' }]
}));
vi.mock('../src/monitor/client.js', () => ({ createMonitorClient: () => ({ meta: async () => ({ capabilities: { ai: { chat: true } } }) }) }));
vi.mock('../src/services/monitorLink.js', () => ({ getMonitorLink: async () => ({ status: () => ({ state: 'reachable', jobs: true }), subscribe: () => () => {} }) }));
vi.mock('../src/ai/browserHost.js', () => ({ browserAiHost: () => ({ host: null, models: {}, subscribe: () => () => {} }) }));
vi.mock('@shared-packages/ui', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
	vi.clearAllMocks();
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
		await fireEvent.click(screen.getByTestId('monitor-ai-model-save'));
		await waitFor(() => expect(mocks.addNative).toHaveBeenCalledWith('http://monitor:8300', { name: 'Voice', task: 'text-to-speech', device: 'cpu', binary: '/bin/piper', model: '/models/voice.onnx' }));
	});
});
