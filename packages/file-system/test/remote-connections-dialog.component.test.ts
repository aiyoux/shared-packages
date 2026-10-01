/**
 * Combined B2 / monitor connections popup, split into a
 * Connections tab (list/new/edit, unchanged) and an AI models tab whose
 * Monitors group hosts one AI panel per saved monitor profile. AI is not a
 * connection kind, and no AI secret is ever stored browser-side.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/svelte';
import 'fake-indexeddb/auto';
import RemoteConnectionsDialog from '../src/ui/RemoteConnectionsDialog.svelte';
import {
	closeCredentialsDbForTests as closeMonitor,
	listProfiles as listMonitor,
	saveProfile as saveMonitor
} from '../src/monitor/credentials.js';
import { DEFAULT_MONITOR_BASE_URL, HUB_MONITOR_DB_NAME } from '../src/monitor/types.js';
import { closeSelectionDbForTests } from '../src/ai/selection.js';
import { HUB_AI_DB_NAME } from '../src/ai/types.js';
import { registerAiLibrarySources, type AiLibraryModelRow } from '../src/ai/modelRegistry.js';
import { getAiSelectionMap, setAiModelRef } from '../src/ai/selection.js';

// The header now hosts the ui package's Tabs primitive, whose indicator
// measures with ResizeObserver — jsdom does not ship one and the test only
// needs the tab buttons to exist.
class StubResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver ??= StubResizeObserver as unknown as typeof ResizeObserver;

async function wipe(name: string) {
	await new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(name);
		req.onsuccess = req.onerror = req.onblocked = () => resolve();
	});
}

async function wipeAll() {
	await closeMonitor();
	await closeSelectionDbForTests();
	await wipe(HUB_MONITOR_DB_NAME);
	await wipe(HUB_AI_DB_NAME);
}

describe('RemoteConnectionsDialog', () => {
	beforeEach(async () => {
		registerAiLibrarySources({ sections: [], surfaces: [] });
		await wipeAll();
	});

	afterEach(async () => {
		registerAiLibrarySources({ sections: [], surfaces: [] });
		vi.unstubAllGlobals();
		await closeMonitor();
		await closeSelectionDbForTests();
	});

	it('groups a mixed catalog by browser and monitor device, keeps API setup per monitor, and preserves the selected device', async () => {
		const browser: AiLibraryModelRow = {
			ref: { location: 'browser', modelId: 'browser-model', sourceId: null, variantId: null },
			label: 'Browser audio', status: 'built-in', sizeBytes: null
		};
		const tools = ['home', 'studio'].map((id): AiLibraryModelRow => ({
			ref: { location: 'monitor-native', modelId: 'audio-tool', sourceId: 'tools', variantId: 'cpu', monitorProfileId: id },
			label: `${id} audio`, status: 'installed', sizeBytes: null
		}));
		const models = vi.fn(async () => [browser, ...tools]);
		registerAiLibrarySources({
			sections: [
				{ id: 'audio', task: 'audio-upsampling', title: 'Audio upsampling', models },
				{ id: 'chat', task: 'chat', title: 'Chat', models: async () => [{ ...browser, label: 'Browser chat', ref: { ...browser.ref, modelId: 'chat-model' } }] }
			],
			surfaces: [{ appId: 'video', task: 'audio-upsampling', label: 'Video audio' }]
		});
		for (const id of ['home', 'studio']) {
			await saveMonitor({ id, name: id, baseUrl: `http://${id}.test:8300`, rootPath: '/tmp' });
		}
		await setAiModelRef('audio-upsampling', 'video', tools[1].ref);
		vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			const name = url.hostname.split('.')[0];
			const body = url.pathname === '/v1/meta' ? { capabilities: { ai: { chat: true } } }
				: url.pathname === '/v1/ai/profiles' ? { profiles: [{ id: 'api', name: `${name} API`, baseUrl: 'https://api.test/v1', source: 'managed', default: false }], defaultProfile: null }
				: url.pathname === '/v1/ai/models' ? { models: [{ id: `${name}-chat`, profile: 'api', profileName: `${name} API`, defaultProfile: false }], errors: [] }
				: url.pathname === '/v1/ai/library' ? { dir: '/models', entries: [] }
				: url.pathname === '/v1/ai/native-models' ? { models: [] } : null;
			return new Response(JSON.stringify(body), { status: body ? 200 : 404 });
		}));
		render(RemoteConnectionsDialog, { props: { onClose: vi.fn() } });
		await fireEvent.click(screen.getByTestId('settings-tab-models'));
		const inBrowser = await screen.findByTestId('ai-browser');
		await within(inBrowser).findByText('Browser audio');
		await within(inBrowser).findByText('Browser chat');
		expect(within(inBrowser).queryByText('home audio')).toBeNull();
		expect(within(inBrowser).queryByText('studio audio')).toBeNull();
		for (const id of ['home', 'studio']) {
			const monitor = await screen.findByTestId(`ai-monitor-${id}`);
			const device = await within(monitor).findByTestId('monitor-ai-native');
			const api = within(monitor).getByTestId('monitor-ai-api');
			expect(within(device).getByText(`${id} audio`)).toBeTruthy();
			expect(within(device).queryByText('Browser audio')).toBeNull();
			expect((await within(api).findByTestId('monitor-ai-profiles')).textContent).toContain(`${id} API`);
			expect(within(api).getByRole('button', { name: 'Add API connection…' })).toBeTruthy();
		}
		await fireEvent.click(within(screen.getByTestId('ai-defaults')).getByText('Default models for apps'));
		const select = screen.getByTestId('ai-default-audio-upsampling-video') as HTMLSelectElement;
		await vi.waitFor(() => expect(JSON.parse(select.value)).toEqual(tools[1].ref));
		await fireEvent.change(select, { target: { value: JSON.stringify(browser.ref) } });
		await vi.waitFor(async () => expect((await getAiSelectionMap()).tasks['audio-upsampling']?.video).toEqual(browser.ref));
		expect(models).toHaveBeenCalledOnce();
	});

	it('lists saved connections; New uses a type segment; Add does not connect', async () => {
		const onConnected = vi.fn();
		render(RemoteConnectionsDialog, { props: { onClose: vi.fn(), onConnected } });
		await screen.findByTestId('connections-dialog');
		expect(screen.getByTestId('connections-profile-new')).toBeTruthy();
		expect(screen.queryByTestId('b2-name')).toBeNull();
		expect(screen.queryByTestId('connections-kind')).toBeNull();

		await fireEvent.click(screen.getByTestId('connections-profile-new'));
		expect(screen.getByTestId('connections-kind-b2')).toBeTruthy();
		expect(screen.getByTestId('connections-kind-monitor')).toBeTruthy();
		// The browser-held AI kind is retired: no segment, no key form.
		expect(screen.queryByTestId('connections-kind-ai')).toBeNull();

		await fireEvent.click(screen.getByTestId('connections-kind-monitor'));
		await fireEvent.input(screen.getByTestId('monitor-name'), { target: { value: 'Home' } });
		await fireEvent.input(screen.getByTestId('monitor-base-url'), {
			target: { value: DEFAULT_MONITOR_BASE_URL }
		});
		await fireEvent.input(screen.getByTestId('monitor-root-path'), { target: { value: '/tmp' } });
		await fireEvent.click(screen.getByTestId('monitor-save-only'));

		await vi.waitFor(async () => expect(await listMonitor()).toHaveLength(1));
		expect(onConnected).not.toHaveBeenCalled();
		await screen.findByText(/Monitor · Home/);
		expect(screen.queryByTestId('connections-kind')).toBeNull();
		await fireEvent.click(screen.getByTestId('monitor-profile-edit'));
		await fireEvent.click(screen.getByTestId('monitor-connect-profile'));
		await vi.waitFor(() => expect(onConnected).toHaveBeenCalled());
	});

	it('the AI models tab hosts one AI panel per saved monitor; install sends the key to the monitor only', async () => {
		// The monitor probe: an AI-capable daemon.
		const posted: Array<{ url: string; body: unknown }> = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith('/v1/meta')) {
					return new Response(
						JSON.stringify({
							name: 'monitor',
							features: ['ai'],
							capabilities: { ai: { chat: true, streaming: true, profiles: 1 } }
						}),
						{ status: 200 }
					);
				}
				if (url.endsWith('/v1/ai/models')) {
					return new Response(
						JSON.stringify({
							models: [{ id: 'm1', profile: 'p1', profileName: 'Local', defaultProfile: true }],
							errors: []
						}),
						{ status: 200 }
					);
				}
				if (url.endsWith('/v1/ai/profiles')) {
					if (init?.method === 'POST') {
						posted.push({ url, body: JSON.parse(String(init.body)) });
						return new Response(
							JSON.stringify({
								id: 'installed-1',
								name: 'Local',
								baseUrl: 'https://api.openai.com/v1',
								default: true,
								source: 'managed',
								keyFingerprint: 'a1b2…9f3c'
							}),
							{ status: 201 }
						);
					}
					return new Response(
						JSON.stringify({
							profiles: [
								{
									id: 'installed-1',
									name: 'Local',
									baseUrl: 'https://api.openai.com/v1',
									default: true,
									source: 'managed',
									keyFingerprint: 'a1b2…9f3c'
								}
							],
							defaultProfile: 'installed-1'
						}),
						{ status: 200 }
					);
				}
				// An older daemon without the b2 feature: B2 rows are simply absent.
				if (url.endsWith('/v1/b2/connections')) return new Response('', { status: 404 });
				throw new Error(`unexpected fetch ${url}`);
			})
		);
		try {
			// The panel is keyed to a saved monitor profile; without one the tab
			// only offers the hint.
			await saveMonitor({
				id: 'm1',
				name: 'Home',
				baseUrl: 'http://127.0.0.1:8300',
				rootPath: '/tmp'
			});
			render(RemoteConnectionsDialog, { props: { onClose: vi.fn() } });
			await screen.findByTestId('connections-dialog');
			expect(screen.queryByTestId('monitor-ai-section')).toBeNull();

			await fireEvent.click(screen.getByTestId('settings-tab-models'));
			// Without a registered library the tab degrades to a note, never a crash.
			expect(screen.getByTestId('ai-library-unavailable')).toBeTruthy();
			// The AI section probes the saved monitor and lists through the
			// monitor transport.
			await screen.findByTestId('monitor-ai-section');
			await vi.waitFor(() => expect(screen.queryByTestId('monitor-ai-probing')).toBeNull());
			await screen.findByTestId('monitor-ai-install-toggle');

			await fireEvent.click(screen.getByTestId('monitor-ai-install-toggle'));
			await fireEvent.input(screen.getByTestId('monitor-ai-name'), { target: { value: 'OpenAI' } });
			await fireEvent.input(screen.getByTestId('monitor-ai-base-url'), {
				target: { value: 'https://api.openai.com/v1' }
			});
			await fireEvent.input(screen.getByTestId('monitor-ai-key'), { target: { value: 'sk-t' } });
			await fireEvent.click(screen.getByTestId('monitor-ai-install-save'));

			await vi.waitFor(() => expect(posted.length).toBe(1));
			expect((posted[0].body as { apiKey?: string }).apiKey).toBe('sk-t');
			// The key existed only in component state; it is cleared after install.
			await vi.waitFor(() => {
				expect((screen.getByTestId('monitor-ai-key') as HTMLInputElement).value).toBe('');
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	/** A monitor that holds one B2 connection and records what it is sent. */
	function stubMonitorB2(sent: Array<{ method: string; url: string; body?: unknown }> = []) {
		const photos = {
			id: 'c1',
			name: 'Photos',
			keyId: '003e2ekeyaaaaaaaaaaaaa',
			bucket: 'photos-bucket',
			namePrefix: '',
			keyFingerprint: 'a1b2…9f3c'
		};
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? 'GET';
				sent.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
				if (url.endsWith('/v1/b2/connections') && method === 'GET') {
					return new Response(JSON.stringify({ connections: [photos] }), { status: 200 });
				}
				if (url.endsWith('/v1/b2/connections') && method === 'POST') {
					const body = JSON.parse(String(init?.body));
					return new Response(
						JSON.stringify({ id: 'c2', name: body.name, keyId: body.keyId, bucket: body.bucket, namePrefix: '' }),
						{ status: 200 }
					);
				}
				throw new Error(`unexpected fetch ${method} ${url}`);
			})
		);
		return sent;
	}

	it('B2 rows come from the monitor that holds them', async () => {
		await saveMonitor({
			id: 'm1',
			name: 'Local',
			baseUrl: DEFAULT_MONITOR_BASE_URL,
			rootPath: '/tmp'
		});
		const sent = stubMonitorB2();
		render(RemoteConnectionsDialog, { props: { onClose: vi.fn() } });
		await screen.findByText(/B2 · Photos/);
		expect(screen.getByText(/via Local/)).toBeTruthy();

		await fireEvent.click(screen.getByTestId('connections-profile-new'));
		expect((screen.getByTestId('b2-monitor') as HTMLSelectElement).value).toBe('m1');
		expect(screen.queryByTestId('b2-persist-secret')).toBeNull();
		await fireEvent.input(screen.getByTestId('b2-name'), { target: { value: 'Archive' } });
		await fireEvent.input(screen.getByTestId('b2-key-id'), { target: { value: '003abc' } });
		await fireEvent.input(screen.getByTestId('b2-key'), { target: { value: 'K005-secret' } });
		await fireEvent.input(screen.getByTestId('b2-bucket'), { target: { value: 'archive' } });
		await fireEvent.click(screen.getByTestId('b2-save-only'));

		await vi.waitFor(() => expect(sent.some((r) => r.method === 'POST')).toBe(true));
		const post = sent.find((r) => r.method === 'POST')!;
		expect(post.url).toBe(`${DEFAULT_MONITOR_BASE_URL}/v1/b2/connections`);
		expect(post.body).toMatchObject({ name: 'Archive', keyId: '003abc', key: 'K005-secret', bucket: 'archive' });
		// Nothing about the key is kept in this browser.
		expect(JSON.stringify(localStorage)).not.toContain('K005-secret');
	});

	it('Edit opens type-specific fields; Cancel returns to the list', async () => {
		await saveMonitor({
			id: 'm1',
			name: 'Local',
			baseUrl: DEFAULT_MONITOR_BASE_URL,
			rootPath: '/tmp'
		});
		stubMonitorB2();
		render(RemoteConnectionsDialog, { props: { onClose: vi.fn() } });
		await screen.findByText(/B2 · Photos/);
		await screen.findByText(/Monitor · Local/);

		await fireEvent.click(screen.getByTestId('b2-profile-edit'));
		expect(screen.getByTestId('b2-name')).toBeTruthy();
		expect(screen.queryByTestId('connections-kind')).toBeNull();
		expect(screen.getByTestId('b2-save-only').textContent).toMatch(/^Update$/);
		await fireEvent.click(screen.getByTestId('connections-cancel'));
		await screen.findByTestId('connections-saved-profiles');
		expect(screen.queryByTestId('b2-name')).toBeNull();

		await fireEvent.click(screen.getByTestId('monitor-profile-edit'));
		expect(screen.getByTestId('monitor-name')).toBeTruthy();
		expect((screen.getByTestId('monitor-name') as HTMLInputElement).value).toBe('Local');
		await fireEvent.input(screen.getByTestId('monitor-name'), { target: { value: 'Renamed' } });
		await fireEvent.click(screen.getByTestId('connections-cancel'));
		expect((await listMonitor())[0]?.name).toBe('Local');
	});
});
