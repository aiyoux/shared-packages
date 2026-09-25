/**
 * Bound AI sessions: REST register/list/delete, and the browser socket's
 * invoke → result framing. A fake WebSocket stands in for the daemon.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
	AiInvokeUnsupported,
	answerSessionInvoke,
	bindAiSession,
	connectAiSession,
	deleteAiSession,
	listAiSessions,
	registerAiSession
} from '../src/ai/sessions.ts';

const BASE = 'http://127.0.0.1:8300';

class FakeSocket {
	static all: FakeSocket[] = [];
	static OPEN = 1;
	static CONNECTING = 0;
	static CLOSING = 2;
	static CLOSED = 3;

	url: string;
	readyState = FakeSocket.CONNECTING;
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	private listeners = new Map<string, Array<() => void>>();

	constructor(url: string) {
		this.url = url;
		FakeSocket.all.push(this);
	}

	addEventListener(type: string, fn: () => void) {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}

	send(data: string) {
		this.sent.push(data);
	}

	close() {
		this.readyState = FakeSocket.CLOSED;
		this.onclose?.();
		for (const fn of this.listeners.get('close') ?? []) fn();
	}

	open() {
		this.readyState = FakeSocket.OPEN;
		this.onopen?.();
	}

	receive(data: string) {
		this.onmessage?.({ data });
	}

	failConnect() {
		for (const fn of this.listeners.get('error') ?? []) fn();
		this.close();
	}
}

const realWebSocket = globalThis.WebSocket;
const realFetch = globalThis.fetch;

afterEach(() => {
	FakeSocket.all = [];
	globalThis.WebSocket = realWebSocket;
	globalThis.fetch = realFetch;
});

function installSocket() {
	globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
}

describe('answerSessionInvoke', () => {
	it('turns an invoke into a result and maps an unsupported action', async () => {
		const ok = await answerSessionInvoke(
			JSON.stringify({ type: 'invoke', id: 'r1', name: 'status', args: {} }),
			async (name) => ({ name })
		);
		assert.deepEqual(JSON.parse(ok!), { type: 'result', id: 'r1', ok: true, value: { name: 'status' } });

		const denied = await answerSessionInvoke(
			JSON.stringify({ type: 'invoke', id: 'r2', name: 'draw', args: {} }),
			async () => {
				throw new AiInvokeUnsupported();
			}
		);
		assert.deepEqual(JSON.parse(denied!), {
			type: 'result',
			id: 'r2',
			ok: false,
			error: 'unsupported'
		});

		assert.equal(await answerSessionInvoke('{"type":"heartbeat"}', async () => null), null);
		assert.equal(await answerSessionInvoke('not-json', async () => null), null);
	});
});

describe('session REST', () => {
	it('registers, lists, and deletes against the monitor envelope', async () => {
		const calls: Array<{ url: string; method: string; body?: string }> = [];
		globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined });
			if (url.endsWith('/v1/ai/sessions') && init?.method === 'POST') {
				return new Response(
					JSON.stringify({
						id: '11111111-1111-4111-8111-111111111111',
						app: 'sketcher',
						title: 'Creative',
						actions: ['snapshot', 'status'],
						bound: false,
						document: null
					}),
					{ status: 201 }
				);
			}
			if (url.endsWith('/v1/ai/sessions') && (init?.method ?? 'GET') === 'GET') {
				return new Response(
					JSON.stringify({
						sessions: [
							{
								id: '11111111-1111-4111-8111-111111111111',
								app: 'sketcher',
								title: 'Creative',
								actions: ['snapshot', 'status'],
								bound: true,
								document: { name: 'A', kind: 'skch' }
							}
						]
					}),
					{ status: 200 }
				);
			}
			if (init?.method === 'DELETE') return new Response(null, { status: 204 });
			return new Response(JSON.stringify({ error: { code: 'ai.session_not_found', message: 'missing' } }), {
				status: 404
			});
		}) as typeof fetch;

		const created = await registerAiSession(BASE, {
			app: 'sketcher',
			title: 'Creative',
			actions: ['snapshot', 'status']
		});
		assert.equal(created.id, '11111111-1111-4111-8111-111111111111');
		assert.equal(created.bound, false);
		assert.equal(JSON.parse(calls[0].body!).app, 'sketcher');

		const rows = await listAiSessions(BASE);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].document?.kind, 'skch');
		assert.equal(rows[0].bound, true);

		await deleteAiSession(BASE, created.id);
		assert.equal(calls[2].method, 'DELETE');
		assert.ok(calls[2].url.endsWith(`/v1/ai/sessions/${created.id}`));
	});
});

describe('session sockets', () => {
	it('binds, answers an invoke, and lets an agent read the value', async () => {
		installSocket();
		let closed = false;
		const bindingPromise = bindAiSession(BASE, 'abc', async (name) => ({ app: 'sketcher', name }), {
			onClose: () => {
				closed = true;
			}
		});
		const browser = FakeSocket.all[0];
		assert.equal(browser.url, 'ws://127.0.0.1:8300/v1/ai/sessions/abc/bind');
		browser.open();
		const binding = await bindingPromise;

		browser.receive(JSON.stringify({ type: 'invoke', id: 'r1', name: 'status', args: {} }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const reply = JSON.parse(browser.sent.at(-1)!);
		assert.equal(reply.ok, true);
		assert.equal(reply.value.name, 'status');

		binding.update({ title: 'Renamed', document: null });
		const update = JSON.parse(browser.sent.at(-1)!);
		assert.equal(update.type, 'update');
		assert.equal(update.title, 'Renamed');
		assert.equal(update.document, null);

		const agentPromise = connectAiSession(BASE, 'abc');
		const agentSocket = FakeSocket.all[1];
		assert.equal(agentSocket.url, 'ws://127.0.0.1:8300/v1/ai/sessions/abc');
		agentSocket.open();
		const agent = await agentPromise;
		const pending = agent.invoke('snapshot');
		const sent = JSON.parse(agentSocket.sent[0]);
		assert.equal(sent.type, 'invoke');
		assert.equal(sent.name, 'snapshot');
		agentSocket.receive(JSON.stringify({ type: 'result', id: sent.id, ok: true, value: { dataUrl: 'data:x' } }));
		assert.deepEqual(await pending, { dataUrl: 'data:x' });

		const denied = agent.invoke('draw');
		const deniedFrame = JSON.parse(agentSocket.sent.at(-1)!);
		agentSocket.receive(
			JSON.stringify({ type: 'result', id: deniedFrame.id, ok: false, error: 'unsupported' })
		);
		await assert.rejects(denied, /unsupported/);

		binding.close();
		assert.equal(closed, true);
	});

	it('rejects the bind when the socket never opens', async () => {
		installSocket();
		const bindingPromise = bindAiSession(BASE, 'abc', async () => null);
		FakeSocket.all[0].failConnect();
		await assert.rejects(bindingPromise, /Could not bind/);
	});
});
