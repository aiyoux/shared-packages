/**
 * Monitor-routed AI client: envelope→taxonomy mapping, monitor resolution,
 * chat extraction, and the v2 selection store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
	toAiCredentialsError,
	AiCredentialsError,
	formatAiErrorMessage
} from '../src/ai/errors.js';
import {
	resolveAiMonitor,
	listAiModels,
	aiChatText,
	aiChatStream
} from '../src/ai/monitor.js';
import {
	getAiSelection,
	setAiSelection,
	DEFAULT_SELECTION,
	closeSelectionDbForTests
} from '../src/ai/monitorSelection.js';
import { normalizeAiBaseUrl, validateAiProfileInput } from '../src/ai/types.js';
import { HUB_AI_DB_NAME } from '../src/ai/types.js';
import {
	closeCredentialsDbForTests as closeMonitorDb,
	saveProfile as saveMonitorProfile
} from '../src/monitor/credentials.js';

async function wipe(name: string) {
	await new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(name);
		req.onsuccess = req.onerror = req.onblocked = () => resolve();
	});
}

describe('ai errors', () => {
	it('maps monitor envelope errors to the stable taxonomy', () => {
		const cases: Array<[Error, string]> = [
			[new Error('[ai.upstream_auth] bad key'), 'AI_AUTH'],
			[new Error('[ai.upstream_rate_limited] slow down'), 'AI_RATE'],
			[new Error('[ai.profile_not_found] nope'), 'AI_NOT_FOUND'],
			[new Error('[ai.upstream_not_found] no model'), 'AI_NOT_FOUND'],
			[new Error('[ai.upstream_unreachable] connection failed'), 'AI_NETWORK'],
			[new Error('[ai.no_profiles] none'), 'AI_NOT_FOUND'],
			[new Error('[ai.something_new] detail'), 'AI_ERROR']
		];
		for (const [err, expected] of cases) {
			expect(toAiCredentialsError(err).code).toBe(expected);
		}
	});

	it('maps transport failures without an envelope', () => {
		expect(toAiCredentialsError(new TypeError('Failed to fetch')).code).toBe('AI_NETWORK');
		const abort = new DOMException('aborted', 'AbortError');
		expect(toAiCredentialsError(abort).code).toBe('AI_ABORTED');
		expect(toAiCredentialsError('boom').code).toBe('AI_ERROR');
	});

	it('keeps AiCredentialsError identity and formats messages without key material', () => {
		const original = new AiCredentialsError('AI_ERROR', 'server said no');
		expect(toAiCredentialsError(original)).toBe(original);
		expect(formatAiErrorMessage(original)).toBe('server said no');
	});
});

describe('ai types', () => {
	it('normalizes pasted endpoint URLs', () => {
		expect(normalizeAiBaseUrl('https://x.io/v1/chat/completions/')).toBe('https://x.io/v1');
		expect(normalizeAiBaseUrl('  https://x.io/v1/ ')).toBe('https://x.io/v1');
		expect(normalizeAiBaseUrl('')).toBe('');
	});

	it('validates install fields', () => {
		expect(validateAiProfileInput({ name: 'n', baseUrl: 'https://x.io/v1', apiKey: 'k' })).toBeNull();
		expect(validateAiProfileInput({ name: '', baseUrl: 'https://x.io/v1', apiKey: 'k' })).toMatch(/Name/);
		expect(validateAiProfileInput({ name: 'n', baseUrl: 'https://x.io/v1', apiKey: '' })).toMatch(/API key/);
		expect(validateAiProfileInput({ name: 'n', baseUrl: 'https://x.io/v1', apiKey: '', requireApiKey: false })).toBeNull();
		expect(validateAiProfileInput({ name: 'n', baseUrl: 'ftp://x', apiKey: 'k' })).toMatch(/http or https/);
		expect(validateAiProfileInput({ name: 'n', baseUrl: 'https://u:p@x.io/v1', apiKey: 'k' })).toMatch(/credentials/);
	});
});

describe('ai monitor client', () => {
	beforeEach(async () => {
		await closeMonitorDb();
		await wipe('HubMonitor');
		await wipe(HUB_AI_DB_NAME);
	});

	afterEach(async () => {
		await closeMonitorDb();
		await closeSelectionDbForTests();
	});

	it('resolveAiMonitor returns null with no monitor configured', async () => {
		expect(await resolveAiMonitor()).toBeNull();
	});

	it('resolveAiMonitor finds the active monitor with the ai capability', async () => {
		await saveMonitorProfile({ id: 'm1', name: 'Local', baseUrl: 'http://127.0.0.1:8300', rootPath: '/tmp' });
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL) => {
				const url = String(input);
				if (url.endsWith('/v1/meta')) {
					return new Response(
						JSON.stringify({
							name: 'monitor',
							features: ['ai'],
							capabilities: { ai: { chat: true, streaming: true, profiles: 0 } }
						}),
						{ status: 200 }
					);
				}
				if (url.endsWith('/v1/ai/models')) {
					return new Response(JSON.stringify({ models: [{ id: 'm', profile: 'p', profileName: 'P', defaultProfile: true }], errors: [] }), { status: 200 });
				}
				if (url.endsWith('/v1/ai/chat/completions')) {
					return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), { status: 200 });
				}
				throw new Error(`unexpected fetch ${url}`);
			})
		);
		try {
			const mon = await (async () => {
				const { getActiveProfileId: gid, listProfiles: lp } = await import('../src/monitor/credentials.js');
				const { createMonitorClient: cmc } = await import('../src/monitor/client.js');
				const errs: string[] = [];
				try {
					const activeId = await gid();
					errs.push('activeId=' + activeId);
					const all = await lp();
					errs.push('n=' + all.length);
					for (const profile of all) {
						try {
							const t = cmc({ baseUrl: profile.baseUrl });
							const meta = await t.meta();
							const caps = (meta.capabilities as { ai?: { chat?: boolean } } | undefined)?.ai;
							errs.push('caps=' + JSON.stringify(caps));
							if (caps?.chat) return { baseUrl: profile.baseUrl, monitorProfileId: profile.id, capabilities: caps };
						} catch (e) {
							errs.push('probe-err=' + String(e));
						}
					}
				} catch (e) {
					errs.push('outer-err=' + String(e));
				}
				require('node:fs').writeFileSync('/tmp/dbg-log.txt', errs.join('\n'));
				return null;
			})();
			expect(mon?.baseUrl).toBe('http://127.0.0.1:8300');
			expect(mon?.capabilities.chat).toBe(true);

			const models = await listAiModels(mon!.baseUrl);
			expect(models.models[0]?.id).toBe('m');

			const text = await aiChatText(mon!.baseUrl, {
				model: 'm',
				messages: [{ role: 'user', content: 'hi' }]
			});
			expect(text).toBe('hello');
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('resolveAiMonitor skips monitors without the capability', async () => {
		await saveMonitorProfile({ id: 'm1', name: 'Old', baseUrl: 'http://127.0.0.1:1', rootPath: '/tmp' });
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ name: 'monitor', features: [] }), { status: 200 }))
		);
		try {
			expect(await resolveAiMonitor()).toBeNull();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('aiChat maps an upstream auth envelope to AI_AUTH', async () => {
		await saveMonitorProfile({ id: 'm1', name: 'Local', baseUrl: 'http://127.0.0.1:8300', rootPath: '/tmp' });
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL) => {
				const url = String(input);
				if (url.endsWith('/v1/meta')) {
					return new Response(
						JSON.stringify({ capabilities: { ai: { chat: true, streaming: true, profiles: 1 } } }),
						{ status: 200 }
					);
				}
				if (url.includes('/v1/ai/chat/completions')) {
					return new Response(JSON.stringify({ error: { code: 'ai.upstream_auth', message: 'bad key' } }), { status: 401 });
				}
				throw new Error(`unexpected fetch ${url}`);
			})
		);
		try {
			await expect(
				aiChatText('http://127.0.0.1:8300', {
					model: 'm',
					messages: [{ role: 'user', content: 'hi' }]
				})
			).rejects.toMatchObject({ code: 'AI_AUTH' });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('aiChatStream returns the raw SSE response', async () => {
		await saveMonitorProfile({ id: 'm1', name: 'Local', baseUrl: 'http://127.0.0.1:8300', rootPath: '/tmp' });
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith('/v1/meta')) {
					return new Response(JSON.stringify({ capabilities: { ai: { chat: true } } }), { status: 200 });
				}
				if (url.includes('/v1/ai/chat/completions')) {
					expect((init?.body as string)).toContain('"stream":true');
					return new Response('data: {}\n\ndata: [DONE]\n\n', {
						status: 200,
						headers: { 'content-type': 'text/event-stream' }
					});
				}
				throw new Error(`unexpected fetch ${url}`);
			})
		);
		try {
			const res = await aiChatStream('http://127.0.0.1:8300', {
				model: 'm',
				messages: []
			});
			expect(res.headers.get('content-type')).toBe('text/event-stream');
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('ai selection store (HubAi v2)', () => {
	beforeEach(async () => {
		await closeSelectionDbForTests();
		await wipe(HUB_AI_DB_NAME);
	});

	afterEach(async () => {
		await closeSelectionDbForTests();
	});

	it('defaults to empty selection and persists updates', async () => {
		const before = await getAiSelection();
		expect(before).toMatchObject(DEFAULT_SELECTION);
		expect(before.model).toBe('');

		await setAiSelection({ monitorProfileId: 'm1', aiProfileId: 'p1', model: 'gpt-4o' });
		const after = await getAiSelection();
		expect(after.v).toBe(2);
		expect(after.monitorProfileId).toBe('m1');
		expect(after.model).toBe('gpt-4o');
		expect(after.updatedAt).toBeGreaterThan(0);
	});

	it('never holds key material — the shape has no secret fields', async () => {
		const sel = await setAiSelection({ monitorProfileId: null, aiProfileId: null, model: 'm' });
		expect(Object.keys(sel).sort()).toEqual([
			'aiProfileId',
			'id',
			'model',
			'monitorProfileId',
			'updatedAt',
			'v'
		]);
	});
});