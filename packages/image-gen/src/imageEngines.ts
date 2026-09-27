import { ImageStore } from './imageStore.js';
import { imageModelDef } from './imageModels.js';
import {
	ImageGenError,
	probeWebGpu,
	type ImageEngine,
	type EngineLoadOpts,
	type ImageGenErrorCode,
	type ImageGenResult
} from './engines.js';

type RpcReply =
	| { id: number; ok: true; result: unknown }
	| { id: number; ok: false; message: string; code?: string };

/**
 * Request/response bridge to the diffusion worker. Mirrors the speech
 * workerRpc shape with image error codes; the hub passes the
 * `new Worker(...)` factory so the bundler sees the literal worker URL.
 */
export function createImageWorkerRpc(
	create: () => Worker,
	label: string,
	onLost: () => void
): {
	call<T>(op: string, payload: Record<string, unknown>, transfer?: Transferable[]): Promise<T>;
	reset(): void;
} {
	let worker: Worker | null = null;
	let seq = 0;
	const waiters = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

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
		created.onmessage = (event: MessageEvent<RpcReply>) => {
			const reply = event.data;
			const waiter = waiters.get(reply.id);
			if (!waiter) return;
			waiters.delete(reply.id);
			if (reply.ok) waiter.resolve(reply.result);
			else {
				waiter.reject(
					new ImageGenError(
						(reply.code as ImageGenErrorCode | undefined) ?? 'GENERATE_FAILED',
						reply.message
					)
				);
			}
		};
		created.onerror = (event) => {
			event.preventDefault();
			failAll(
				new ImageGenError(
					'GENERATE_FAILED',
					`${label} worker failed${event.message ? `: ${event.message}` : ' to start'}`
				)
			);
			drop();
		};
		worker = created;
		return created;
	}

	return {
		call<T>(op: string, payload: Record<string, unknown>, transfer?: Transferable[]): Promise<T> {
			const id = ++seq;
			const target = start();
			return new Promise<T>((resolve, reject) => {
				waiters.set(id, {
					resolve: (v) => resolve(v as T),
					reject
				});
				target.postMessage({ id, op, payload }, transfer ?? []);
			});
		},
		reset(): void {
			failAll(new ImageGenError('CANCELLED', `${label} worker reset`));
			drop();
		}
	};
}

export type ImageEngineFactory = (createWorker: () => Worker) => {
	load(opts: EngineLoadOpts): Promise<ImageEngine>;
};

/**
 * Load an SD-family engine: probe WebGPU, resolve the VFS folder, hand the
 * weight blobs to a fresh worker (transferred), and return a tiny engine
 * handle. Weights travel blob → copy → transfer; the transient 2× peak is
 * the price of never touching the network.
 */
export function createSdEngine(createWorker: () => Worker): {
	load(opts: EngineLoadOpts): Promise<ImageEngine>;
} {
	return {
		async load(opts: EngineLoadOpts): Promise<ImageEngine> {
			const probe = await probeWebGpu();
			if (!probe.ok) throw new ImageGenError('UNSUPPORTED_DEVICE', probe.reason);
			const def = imageModelDef(opts.modelId ?? 'sd-turbo');
			const store = await ImageStore.get();
			const dirId = opts.dirId ?? (await store.findModelDir(def, null));
			if (!dirId) {
				throw new ImageGenError(
					'NO_MODEL',
					`${def.id} weights are not in Files — download them first`
				);
			}
			let loadedId: string | null = null;
			const rpc = createImageWorkerRpc(createWorker, 'image', () => (loadedId = null));
			const files: Array<{ path: string; buffer: ArrayBuffer }> = [];
			const transfer: Transferable[] = [];
			try {
				for (const file of def.files) {
					opts.signal?.throwIfAborted();
					const bytes = await store.readBytesPath(dirId, file.path);
					const copy = bytes.slice().buffer as ArrayBuffer;
					files.push({ path: file.path, buffer: copy });
					transfer.push(copy);
					opts.onProgress?.(`Loading ${file.path}`, files.length / def.files.length);
				}
				const out = await rpc.call<{ modelId: string }>('load', { modelId: def.id, files }, transfer);
				loadedId = out.modelId;
			} catch (err) {
				rpc.reset();
				if (err instanceof DOMException && err.name === 'AbortError') {
					throw new ImageGenError('CANCELLED', 'Model load cancelled');
				}
				throw err;
			}
			return {
				modelId: def.id,
				async generate(prompt, genOpts): Promise<ImageGenResult> {
					if (!loadedId) throw new ImageGenError('NO_MODEL', 'Engine was reset — load again');
					const out = await rpc.call<{ width: number; height: number; seed: number; rgba: ArrayBuffer }>(
						'generate',
						{ prompt, seed: genOpts?.seed },
						[]
					);
					genOpts?.signal?.throwIfAborted();
					return {
						data: new Uint8ClampedArray(out.rgba),
						width: out.width,
						height: out.height,
						seed: out.seed
					};
				},
				dispose(): void {
					rpc.reset();
				}
			};
		}
	};
}
