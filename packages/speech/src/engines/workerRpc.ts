/**
 * Request/response bridge to a dedicated inference worker. Local TTS engines
 * run ORT in a worker so a sentence render never blocks the page; the page
 * side keeps the VFS, playback and progress.
 *
 * The caller passes the `new Worker(new URL(..., import.meta.url))` factory so
 * the bundler sees the literal worker URL in the engine's own module.
 */

import { SpeechEngineError } from '../types.js';

type ErrorCode = SpeechEngineError['code'];
const resets = new Map<() => void, string>();
export function resetInferenceWorkers(label?: string): void { for (const [reset, name] of resets) if (!label || label === name) reset(); }

export type WorkerReply =
	| { id: number; ok: true; result: unknown }
	| { id: number; ok: false; message: string; code?: ErrorCode }
	| { id: number; progress: unknown };

export type WorkerRpc = {
	call<T>(op: string, payload: object, transfer?: Transferable[], onProgress?: (value: unknown) => void): Promise<T>;
	/** Drop the worker (and whatever it had loaded); the next call starts a fresh one. */
	reset(): void;
};

/**
 * `onLost` fires when the worker dies (script failed to load, or an uncaught
 * error / OOM killed it) so the engine forgets what that worker had loaded.
 */
export function createWorkerRpc(create: () => Worker, label: string, onLost: () => void): WorkerRpc {
	let worker: Worker | null = null;
	let seq = 0;
	const waiters = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; progress?: (value: unknown) => void }>();

	function failAll(err: Error): void {
		for (const waiter of waiters.values()) waiter.reject(err);
		waiters.clear();
	}

	function drop(): void {
		worker?.terminate();
		worker = null;
		onLost();
	}

	function start(): Worker {
		if (worker) return worker;
		const created = create();
		created.onmessage = (event: MessageEvent<WorkerReply>) => {
			const reply = event.data;
			const waiter = waiters.get(reply.id);
			if (!waiter) return;
			if ('progress' in reply) { waiter.progress?.(reply.progress); return; }
			waiters.delete(reply.id);
			if (reply.ok) waiter.resolve(reply.result);
			else waiter.reject(new SpeechEngineError(reply.code ?? 'SYNTHESIS_FAILED', reply.message));
		};
		created.onerror = (event) => {
			event.preventDefault();
			failAll(
				new SpeechEngineError(
					'SYNTHESIS_FAILED',
					`${label} worker failed${event.message ? `: ${event.message}` : ' to start'}`
				)
			);
			drop();
		};
		worker = created;
		return created;
	}

	const reset = () => { failAll(new SpeechEngineError('CANCELLED', `${label} worker reset`)); drop(); };
	resets.set(reset, label);
	return {
		call<T>(op: string, payload: object, transfer: Transferable[] = [], onProgress?: (value: unknown) => void): Promise<T> {
			const target = start();
			const id = ++seq;
			return new Promise<T>((resolve, reject) => {
				waiters.set(id, { resolve: resolve as (v: unknown) => void, reject, progress: onProgress });
				try { target.postMessage({ id, op, ...payload }, transfer); } catch (error) { waiters.delete(id); reject(error); }
			});
		},
		reset() {
			failAll(new SpeechEngineError('CANCELLED', `${label} worker reset`));
			drop();
		}
	};
}

/**
 * Worker side: route `{ id, op, ...payload }` requests to handlers and post
 * each result (with its transfer list) or error back.
 */
export function serveWorkerRpc(
	handlers: Record<string, (payload: Record<string, unknown>, progress: (value: unknown) => void) => Promise<{ result: unknown; transfer?: Transferable[] }>>
): void {
	const scope = self as unknown as {
		onmessage: ((event: MessageEvent<{ id: number; op: string } & Record<string, unknown>>) => void) | null;
		postMessage: (message: WorkerReply, transfer?: Transferable[]) => void;
	};
	// One request at a time: ORT sessions are not re-entrant, and the page
	// only ever keeps one sentence of lookahead in flight anyway.
	let queue: Promise<void> = Promise.resolve();
	scope.onmessage = (event) => {
		const { id, op, ...payload } = event.data;
		queue = queue.then(async () => {
			const handler = handlers[op];
			try {
				if (!handler) throw new Error(`Unknown worker op: ${op}`);
				const { result, transfer } = await handler(payload, (value) => scope.postMessage({ id, progress: value }));
				scope.postMessage({ id, ok: true, result }, transfer ?? []);
			} catch (err) {
				scope.postMessage({
					id,
					ok: false,
					message: err instanceof Error ? err.message : String(err),
					code: err instanceof SpeechEngineError ? err.code : undefined
				});
			}
		});
	};
}
