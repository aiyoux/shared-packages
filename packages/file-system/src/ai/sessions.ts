/**
 * Bound AI sessions on the monitor (`/v1/ai/sessions`).
 *
 * A browser tab registers, then holds a WebSocket open at
 * `/v1/ai/sessions/{id}/bind`. That socket is the heartbeat. An agent lists
 * `GET /v1/ai/sessions` and opens `/v1/ai/sessions/{id}` to send
 * `{ type: "invoke", name, args }` and read `{ type: "result", ... }`.
 * The daemon forwards frames; it does not interpret action names.
 *
 * Keys stay daemon-side. These calls are keyless, same as chat.
 */
import { AiCredentialsError, toAiCredentialsError } from './errors.js';
import { withLocalAddressSpace } from '../monitor/localNetwork.js';

/** How often the browser socket tells the daemon it is still open. */
export const AI_SESSION_HEARTBEAT_MS = 10_000;

export type AiSessionDocument = Record<string, unknown>;

/** One row from `GET /v1/ai/sessions`. */
/** One file the bound tab has placed on the monitor for a local agent to read. */
export type AiSessionArtifact = {
	name: string;
	path: string;
	bytes: number;
	sha256: string;
	updated: string;
};

export type AiSessionInfo = {
	id: string;
	app: string;
	title: string;
	actions: string[];
	bound: boolean;
	document: AiSessionDocument | null;
	/** Empty when the tab has not granted access. An old daemon omits this. */
	grants: string[];
	artifacts: AiSessionArtifact[];
};

export type AiSessionRegisterInput = {
	app: string;
	title: string;
	actions: string[];
	document?: object | null;
};

/** Thrown by an invoke handler when the tab does not implement that action. */
export class AiInvokeUnsupported extends Error {
	constructor() {
		super('unsupported');
		this.name = 'AiInvokeUnsupported';
	}
}

export type AiSessionInvokeHandler = (
	name: string,
	args: Record<string, unknown>
) => Promise<unknown>;

export type AiSessionArtifactUpload = {
	name: 'file' | 'debug';
	filename: string;
	bytes: Uint8Array;
};

/** The browser side of a bound session. */
export type AiSessionBinding = {
	update(patch: {
		title?: string;
		document?: object | null;
		grants?: string[];
		actions?: string[];
	}): void;
	/** Upload one artifact on the bind socket. Resolves with the daemon's path record. */
	sendArtifact(input: AiSessionArtifactUpload): Promise<AiSessionArtifact>;
	close(): void;
};

/** Upload one artifact. The binding must already be open. */
export function sendSessionArtifact(
	binding: AiSessionBinding,
	input: AiSessionArtifactUpload
): Promise<AiSessionArtifact> {
	return binding.sendArtifact(input);
}

const ARTIFACT_CHUNK_BYTES = 8 * 1024 * 1024;

/** The agent side of a bound session. */
export type AiSessionAgent = {
	invoke(name: string, args?: Record<string, unknown>): Promise<unknown>;
	close(): void;
};

function joinUrl(base: string, path: string): string {
	const b = base.replace(/\/$/, '');
	const p = path.startsWith('/') ? path : `/${path}`;
	return `${b}${p}`;
}

function toWebSocketUrl(httpUrl: string): string {
	if (httpUrl.startsWith('https://')) return `wss://${httpUrl.slice('https://'.length)}`;
	if (httpUrl.startsWith('http://')) return `ws://${httpUrl.slice('http://'.length)}`;
	return httpUrl;
}

function sessionPath(id: string, suffix = ''): string {
	return `/v1/ai/sessions/${encodeURIComponent(id)}${suffix}`;
}

async function aiFetch(baseUrl: string, path: string, init: RequestInit): Promise<Response> {
	const url = joinUrl(baseUrl, path);
	try {
		const res = await fetch(url, withLocalAddressSpace(url, init));
		if (!res.ok) {
			const parsed = (await res.json().catch(() => ({}))) as {
				error?: { message?: string; code?: string } | string;
			};
			const err = parsed.error;
			const msg =
				typeof err === 'string'
					? err
					: err && typeof err === 'object' && 'message' in err
						? String(err.message)
						: res.statusText;
			const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
			throw new Error(
				code ? `[${code}] ${msg || res.statusText}` : msg || `Monitor AI request failed (${res.status})`
			);
		}
		return res;
	} catch (e) {
		throw toAiCredentialsError(e);
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

export function coerceAiSession(raw: unknown): AiSessionInfo {
	const row = asRecord(raw);
	if (!row || typeof row.id !== 'string' || !row.id) {
		throw new AiCredentialsError('AI_ERROR', 'The monitor returned a malformed AI session.');
	}
	const actions = Array.isArray(row.actions)
		? row.actions.filter((name): name is string => typeof name === 'string')
		: [];
	const document = asRecord(row.document);
	const grants = Array.isArray(row.grants)
		? row.grants.filter((name): name is string => typeof name === 'string')
		: [];
	const artifacts = Array.isArray(row.artifacts)
		? row.artifacts.flatMap((item) => {
				const artifact = coerceArtifact(item);
				return artifact ? [artifact] : [];
			})
		: [];
	return {
		id: row.id,
		app: typeof row.app === 'string' ? row.app : '',
		title: typeof row.title === 'string' ? row.title : '',
		actions,
		bound: row.bound === true,
		document,
		grants,
		artifacts
	};
}

function coerceArtifact(raw: unknown): AiSessionArtifact | null {
	const row = asRecord(raw);
	if (!row || typeof row.name !== 'string' || typeof row.path !== 'string') return null;
	return {
		name: row.name,
		path: row.path,
		bytes: typeof row.bytes === 'number' && Number.isFinite(row.bytes) ? row.bytes : 0,
		sha256: typeof row.sha256 === 'string' ? row.sha256 : '',
		updated: typeof row.updated === 'string' ? row.updated : ''
	};
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `POST /v1/ai/sessions`. The session stays hidden until `bindAiSession` connects. */
export async function registerAiSession(
	baseUrl: string,
	input: AiSessionRegisterInput
): Promise<AiSessionInfo> {
	const res = await aiFetch(baseUrl, '/v1/ai/sessions', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			app: input.app,
			title: input.title,
			actions: input.actions,
			document: input.document ?? null
		})
	});
	return coerceAiSession(await res.json());
}

/** `GET /v1/ai/sessions` — tabs whose browser socket is connected. */
export async function listAiSessions(baseUrl: string): Promise<AiSessionInfo[]> {
	const res = await aiFetch(baseUrl, '/v1/ai/sessions', { method: 'GET' });
	const body = (await res.json()) as { sessions?: unknown };
	if (!Array.isArray(body.sessions)) return [];
	return body.sessions.map((row) => coerceAiSession(row));
}

/** `DELETE /v1/ai/sessions/{id}`. A missing session is an error the caller can ignore on unload. */
export async function deleteAiSession(baseUrl: string, id: string): Promise<void> {
	await aiFetch(baseUrl, sessionPath(id), { method: 'DELETE' });
}

/** Absolute DELETE URL, for a `keepalive` fetch during page unload. */
export function aiSessionDeleteUrl(baseUrl: string, id: string): string {
	return joinUrl(baseUrl, sessionPath(id));
}

function clipError(e: unknown): string {
	const message = e instanceof Error && e.message ? e.message.trim() : '';
	const text = message || 'unsupported';
	return text.length > 200 ? text.slice(0, 200) : text;
}

/**
 * Answer one daemon frame. Returns the JSON text to send back, or null when
 * the frame is not an invoke (those are ignored).
 */
export async function answerSessionInvoke(
	text: string,
	handler: AiSessionInvokeHandler
): Promise<string | null> {
	let msg: Record<string, unknown>;
	try {
		const parsed = JSON.parse(text) as unknown;
		const row = asRecord(parsed);
		if (!row) return null;
		msg = row;
	} catch {
		return null;
	}
	if (msg.type !== 'invoke') return null;
	const id = typeof msg.id === 'string' ? msg.id : '';
	const name = typeof msg.name === 'string' ? msg.name : '';
	const args = asRecord(msg.args) ?? {};
	try {
		const value = await handler(name, args);
		return JSON.stringify({ type: 'result', id, ok: true, value: value ?? null });
	} catch (e) {
		const error = e instanceof AiInvokeUnsupported ? 'unsupported' : clipError(e);
		return JSON.stringify({ type: 'result', id, ok: false, error });
	}
}

/**
 * Hold the browser socket open. Resolves once the daemon has accepted the
 * upgrade. `onClose` runs when the socket ends, including a daemon-side drop.
 */
export function bindAiSession(
	baseUrl: string,
	id: string,
	handler: AiSessionInvokeHandler,
	opts?: { onClose?: () => void }
): Promise<AiSessionBinding> {
	const url = toWebSocketUrl(joinUrl(baseUrl, sessionPath(id, '/bind')));
	const ws = new WebSocket(url);
	let chain: Promise<void> = Promise.resolve();
	let closed = false;
	let artifactWait: {
		name: string;
		resolve: (value: AiSessionArtifact) => void;
		reject: (error: Error) => void;
	} | null = null;
	const timer = setInterval(() => {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: 'heartbeat' }));
		}
	}, AI_SESSION_HEARTBEAT_MS);

	function finish() {
		if (closed) return;
		closed = true;
		clearInterval(timer);
		artifactWait?.reject(new AiCredentialsError('AI_ERROR', 'The AI session socket closed.'));
		artifactWait = null;
		opts?.onClose?.();
	}

	ws.onmessage = (ev) => {
		const text = typeof ev.data === 'string' ? ev.data : '';
		if (!text) return;
		const ack = asRecord(safeParse(text));
		if (ack?.type === 'artifact') {
			const waiter = artifactWait;
			if (!waiter || ack.name !== waiter.name) return;
			artifactWait = null;
			if (ack.ok === true && typeof ack.path === 'string') {
				waiter.resolve({
					name: waiter.name,
					path: ack.path,
					bytes: typeof ack.bytes === 'number' ? ack.bytes : 0,
					sha256: typeof ack.sha256 === 'string' ? ack.sha256 : '',
					updated: ''
				});
			} else {
				waiter.reject(
					new AiCredentialsError(
						'AI_ERROR',
						typeof ack.error === 'string' && ack.error ? ack.error : 'unsupported'
					)
				);
			}
			return;
		}
		chain = chain
			.then(async () => {
				const reply = await answerSessionInvoke(text, handler);
				if (reply && ws.readyState === WebSocket.OPEN) ws.send(reply);
			})
			.catch(() => {
				/* answerSessionInvoke already turns handler failures into a result frame */
			});
	};
	ws.onclose = () => finish();
	ws.onerror = () => {
		/* onclose follows; the bind promise rejects if we never opened */
	};

	return new Promise((resolve, reject) => {
		let settled = false;
		const binding: AiSessionBinding = {
			update(patch) {
				if (ws.readyState !== WebSocket.OPEN) return;
				const frame: Record<string, unknown> = { type: 'update' };
				if (patch.title !== undefined) frame.title = patch.title;
				if (patch.document !== undefined) frame.document = patch.document;
				if (patch.grants !== undefined) frame.grants = patch.grants;
				if (patch.actions !== undefined) frame.actions = patch.actions;
				ws.send(JSON.stringify(frame));
			},
			sendArtifact(input) {
				if (ws.readyState !== WebSocket.OPEN) {
					return Promise.reject(
						new AiCredentialsError('AI_ERROR', 'The AI session socket closed.')
					);
				}
				if (artifactWait) {
					return Promise.reject(
						new AiCredentialsError('AI_ERROR', 'An artifact upload is already in progress.')
					);
				}
				return sha256Hex(input.bytes).then(
					(sha256) =>
						new Promise<AiSessionArtifact>((resolve, reject) => {
							artifactWait = { name: input.name, resolve, reject };
							ws.send(
								JSON.stringify({
									type: 'artifact-begin',
									name: input.name,
									bytes: input.bytes.byteLength,
									sha256,
									filename: input.filename
								})
							);
							for (let offset = 0; offset < input.bytes.byteLength; offset += ARTIFACT_CHUNK_BYTES) {
								const slice = input.bytes.subarray(offset, Math.min(offset + ARTIFACT_CHUNK_BYTES, input.bytes.byteLength));
								ws.send(slice);
							}
							ws.send(JSON.stringify({ type: 'artifact-end', name: input.name }));
						})
				);
			},
			close() {
				finish();
				if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
					ws.close();
				}
			}
		};
		const fail = () => {
			if (settled) return;
			settled = true;
			closed = true;
			clearInterval(timer);
			reject(
				new AiCredentialsError(
					'AI_NETWORK',
					'Could not bind this tab to the monitor AI session.'
				)
			);
		};
		ws.onopen = () => {
			if (settled) return;
			settled = true;
			resolve(binding);
		};
		ws.addEventListener('error', fail, { once: true });
		ws.addEventListener('close', () => {
			if (!settled) fail();
		});
	});
}

/**
 * Agent socket. `invoke` resolves with the tab's `value`, or rejects when
 * the tab answers `ok: false` or the session is gone.
 */
export function connectAiSession(baseUrl: string, id: string): Promise<AiSessionAgent> {
	const url = toWebSocketUrl(joinUrl(baseUrl, sessionPath(id)));
	const ws = new WebSocket(url);
	const pending = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();

	function failAll(error: Error) {
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
	}

	ws.onmessage = (ev) => {
		let msg: Record<string, unknown> | null = null;
		try {
			msg = asRecord(JSON.parse(String(ev.data)));
		} catch {
			msg = null;
		}
		if (!msg) return;
		if (msg.type === 'gone') {
			failAll(new AiCredentialsError('AI_ERROR', 'The AI session is gone.'));
			ws.close();
			return;
		}
		if (msg.type !== 'result' || typeof msg.id !== 'string') return;
		const waiter = pending.get(msg.id);
		if (!waiter) return;
		pending.delete(msg.id);
		if (msg.ok === true) waiter.resolve(msg.value ?? null);
		else {
			waiter.reject(
				new AiCredentialsError(
					'AI_ERROR',
					typeof msg.error === 'string' && msg.error ? msg.error : 'unsupported'
				)
			);
		}
	};
	ws.onclose = () => {
		failAll(new AiCredentialsError('AI_ERROR', 'The AI session socket closed.'));
	};

	return new Promise((resolve, reject) => {
		ws.onopen = () => {
			resolve({
				invoke(name, args) {
					const requestId = crypto.randomUUID();
					return new Promise((resolveInvoke, rejectInvoke) => {
						if (ws.readyState !== WebSocket.OPEN) {
							rejectInvoke(new AiCredentialsError('AI_ERROR', 'The AI session socket closed.'));
							return;
						}
						pending.set(requestId, { resolve: resolveInvoke, reject: rejectInvoke });
						ws.send(
							JSON.stringify({
								type: 'invoke',
								id: requestId,
								name,
								args: args ?? {}
							})
						);
					});
				},
				close() {
					ws.close();
				}
			});
		};
		ws.addEventListener(
			'error',
			() => {
				reject(
					new AiCredentialsError('AI_NETWORK', 'Could not connect to the monitor AI session.')
				);
			},
			{ once: true }
		);
	});
}
