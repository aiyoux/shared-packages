/**
 * Combined B2 / rclone / monitor connections popup. AI is not a connection
 * kind: it is configured per monitor (MonitorAiSection), and no AI secret is
 * ever stored browser-side.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import 'fake-indexeddb/auto';
import RemoteConnectionsDialog from '../src/ui/RemoteConnectionsDialog.svelte';
import {
	closeCredentialsDbForTests as closeB2,
	listProfiles as listB2,
	saveProfile as saveB2
} from '../src/b2/credentials.js';
import { HUB_B2_DB_NAME } from '../src/b2/types.js';
import {
	closeCredentialsDbForTests as closeRclone,
	listProfiles as listRclone
} from '../src/rclone/credentials.js';
import { HUB_RCLONE_DB_NAME } from '../src/rclone/types.js';
import {
	closeCredentialsDbForTests as closeMonitor,
	listProfiles as listMonitor,
	saveProfile as saveMonitor
} from '../src/monitor/credentials.js';
import { DEFAULT_MONITOR_BASE_URL, HUB_MONITOR_DB_NAME } from '../src/monitor/types.js';
import { closeSelectionDbForTests } from '../src/ai/monitorSelection.js';
import { HUB_AI_DB_NAME } from '../src/ai/types.js';

async function wipe(name: string) {
	await new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(name);
		req.onsuccess = req.onerror = req.onblocked = () => resolve();
	});
}

async function wipeAll() {
	await closeB2();
	await closeRclone();
	await closeMonitor();
	await closeSelectionDbForTests();
	await wipe(HUB_B2_DB_NAME);
	await wipe(HUB_RCLONE_DB_NAME);
	await wipe(HUB_MONITOR_DB_NAME);
	await wipe(HUB_AI_DB_NAME);
}

describe('RemoteConnectionsDialog', () => {
	beforeEach(async () => {
		await wipeAll();
	});

	afterEach(async () => {
		await closeB2();
		await closeRclone();
		await closeMonitor();
		await closeSelectionDbForTests();
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
		expect(screen.getByTestId('connections-kind-rclone')).toBeTruthy();
		expect(screen.getByTestId('connections-kind-monitor')).toBeTruthy();
		// The browser-held AI kind is retired: no segment, no key form.
		expect(screen.queryByTestId('connections-kind-ai')).toBeNull();

		await fireEvent.click(screen.getByTestId('connections-kind-rclone'));
		expect(screen.getByTestId('rclone-name')).toBeTruthy();
		expect(screen.queryByTestId('b2-name')).toBeNull();

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
		await fireEvent.click(screen.getByTestId('monitor-connect-profile'));
		await vi.waitFor(() => expect(onConnected).toHaveBeenCalled());
	});

	it('monitor form hosts the AI section; install sends the key to the monitor only', async () => {
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
				throw new Error(`unexpected fetch ${url}`);
			})
		);
		try {
			render(RemoteConnectionsDialog, { props: { onClose: vi.fn() } });
			await screen.findByTestId('connections-dialog');

			await fireEvent.click(screen.getByTestId('connections-profile-new'));
			await fireEvent.click(screen.getByTestId('connections-kind-monitor'));
			await fireEvent.input(screen.getByTestId('monitor-base-url'), {
				target: { value: 'http://127.0.0.1:8300' }
			});

			// The AI section probes and lists through the monitor transport.
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
			expect((await listB2()).length).toBe(0);
			expect(await listMonitor()).toHaveLength(0);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('Edit opens type-specific fields; Cancel returns to the list', async () => {
		await saveMonitor({
			id: 'm1',
			name: 'Local',
			baseUrl: DEFAULT_MONITOR_BASE_URL,
			rootPath: '/tmp'
		});
		await saveB2({
			id: 'b1',
			name: 'Photos',
			applicationKeyId: '003e2ekeyaaaaaaaaaaaaa',
			applicationKey: 'secret-key',
			bucketName: 'photos-bucket'
		});
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
		expect((await listB2())[0]?.name).toBe('Photos');
		expect(await listRclone()).toHaveLength(0);
	});
});