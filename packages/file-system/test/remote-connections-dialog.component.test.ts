/**
 * Combined B2 / rclone / monitor connections popup.
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
import {
	closeCredentialsDbForTests as closeAi,
	listProfiles as listAi,
	saveProfile as saveAi
} from '../src/ai/credentials.js';
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
	await closeAi();
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
		await closeAi();
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
		expect(screen.getByTestId('b2-name')).toBeTruthy();

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

	it('adds an AI profile: fields, model, and connect', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL) => {
				const url = String(input);
				if (url.endsWith('/models')) {
					return new Response(JSON.stringify({ data: [{ id: 'm2' }, { id: 'm1' }] }), {
						status: 200
					});
				}
				throw new Error(`unexpected fetch ${url}`);
			})
		);
		try {
			const onConnected = vi.fn();
			render(RemoteConnectionsDialog, { props: { onClose: vi.fn(), onConnected } });
			await screen.findByTestId('connections-dialog');

			await fireEvent.click(screen.getByTestId('connections-profile-new'));
			await fireEvent.click(screen.getByTestId('connections-kind-ai'));
			expect(screen.getByTestId('ai-name')).toBeTruthy();
			expect(screen.queryByTestId('b2-name')).toBeNull();

			await fireEvent.input(screen.getByTestId('ai-name'), { target: { value: 'GPT' } });
			await fireEvent.input(screen.getByTestId('ai-base-url'), {
				target: { value: 'http://127.0.0.1:9/v1/chat/completions' }
			});
			await fireEvent.input(screen.getByTestId('ai-key'), { target: { value: 'sk-t' } });

			await fireEvent.click(screen.getByTestId('ai-load-models'));
			await screen.findByText('m1');
			// First sorted model is auto-selected in the dropdown.
			expect((screen.getByTestId('ai-model') as HTMLSelectElement).value).toBe('m1');
			// The pasted /chat/completions suffix was stripped from the probe URL.
			const modelsUrl = String(
				(vi.mocked(fetch).mock.calls[0] as unknown as [string])[0]
			);
			expect(modelsUrl).toBe('http://127.0.0.1:9/v1/models');

			await fireEvent.click(screen.getByTestId('ai-save-only'));
			await vi.waitFor(async () => expect(await listAi()).toHaveLength(1));
			const [p] = await listAi();
			expect(p.baseUrl).toBe('http://127.0.0.1:9/v1');
			expect(p.apiKey).toBe('sk-t');
			expect(p.model).toBe('m1');
			expect(onConnected).not.toHaveBeenCalled();

			await screen.findByText(/AI · GPT/);
			await fireEvent.click(screen.getByTestId('ai-profile-select'));
			await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith('ai', expect.anything()));
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('shows the model-load failure inline and keeps free-text model entry', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('nope', { status: 500 }))
		);
		try {
			render(RemoteConnectionsDialog, { props: { onClose: vi.fn() } });
			await screen.findByTestId('connections-dialog');
			await fireEvent.click(screen.getByTestId('connections-profile-new'));
			await fireEvent.click(screen.getByTestId('connections-kind-ai'));

			await fireEvent.click(screen.getByTestId('ai-load-models'));
			await screen.findByTestId('ai-models-error');
			// No models loaded → the model field stays a free-text input.
			const model = screen.getByTestId('ai-model') as HTMLInputElement;
			expect(model.tagName).toBe('INPUT');
			await fireEvent.input(model, { target: { value: 'llava' } });
			expect(screen.queryByTestId('ai-test-result')).toBeNull();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('edits an AI profile keeping the stored key when blank', async () => {
		await saveAi({ id: 'a1', name: 'GPT', baseUrl: 'https://x.io/v1', apiKey: 'sk-keep', model: 'm' });
		render(RemoteConnectionsDialog, { props: { onClose: vi.fn() } });
		await screen.findByText(/AI · GPT/);

		await fireEvent.click(screen.getByTestId('ai-profile-edit'));
		expect((screen.getByTestId('ai-key') as HTMLInputElement).value).toBe('');
		await fireEvent.input(screen.getByTestId('ai-name'), { target: { value: 'GPT2' } });
		await fireEvent.click(screen.getByTestId('ai-save-only'));

		await vi.waitFor(async () => expect((await listAi())[0]?.name).toBe('GPT2'));
		expect((await listAi())[0]?.apiKey).toBe('sk-keep');
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
