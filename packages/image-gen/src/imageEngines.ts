import { registerBrowserAiHandler, runBrowserAi } from '@shared-packages/file-system/ai';
import { browserModelStore, ModelStoreError } from '@shared-packages/model-store';
import { imageBrowserModel, imageModelDef } from './imageModels.js';
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
 * Load a diffusion engine: probe WebGPU, read the model from the browser
 * model store, hand the weights to a fresh worker (transferred), and return
 * a tiny engine handle. The worker URL and label vary
 * per family — the hub passes `createSdEngine`/`createFlux2Engine` the
 * matching `new Worker(...)` factory.
 */
function createWorkerEngine(
	createWorker: () => Worker,
	label: string,
	fallbackModelId: string
): {
	load(opts: EngineLoadOpts): Promise<ImageEngine>;
} {
	return {
		async load(opts: EngineLoadOpts): Promise<ImageEngine> {
			const probe = await probeWebGpu();
			if (!probe.ok) throw new ImageGenError('UNSUPPORTED_DEVICE', probe.reason);
			const def = imageModelDef(opts.modelId ?? fallbackModelId);
			let loadedId: string | null = null;
			const rpc = createImageWorkerRpc(createWorker, label, () => (loadedId = null));
			const abort = () => rpc.reset();
			opts.signal?.addEventListener('abort', abort, { once: true });
			try {
				// The shared model lock is held until the worker has its copy, so a
				// clear or replace in Settings waits rather than tearing the load.
				await browserModelStore.readReady(imageBrowserModel(def), async (snapshot) => {
					const files: Array<{ path: string; buffer: ArrayBuffer }> = [];
					const transfer: Transferable[] = [];
					for (const file of def.files) {
						opts.signal?.throwIfAborted();
						const buffer = await (await snapshot.file(file.path)).arrayBuffer();
						files.push({ path: file.path, buffer });
						transfer.push(buffer);
						opts.onProgress?.(`Loading ${file.path}`, files.length / def.files.length);
					}
					const out = await rpc.call<{ modelId: string }>('load', { modelId: def.id, files }, transfer);
					loadedId = out.modelId;
				}, { signal: opts.signal });
			} catch (err) {
				rpc.reset();
				if (err instanceof DOMException && err.name === 'AbortError') {
					throw new ImageGenError('CANCELLED', 'Model load cancelled');
				}
				if (err instanceof ModelStoreError && err.code === 'MISSING_FILES') throw new ImageGenError('NO_MODEL', err.message);
				throw err;
			} finally {
				opts.signal?.removeEventListener('abort', abort);
			}
			return {
				modelId: def.id,
				async generate(prompt, genOpts): Promise<ImageGenResult> {
					if (!loadedId) throw new ImageGenError('NO_MODEL', 'Engine was reset — load again');
					const out = await rpc.call<{ width: number; height: number; seed: number; rgba: ArrayBuffer }>(
						'generate',
						{
							prompt,
							seed: genOpts?.seed,
							width: genOpts?.width,
							height: genOpts?.height
						},
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

/** SD-family engine (sd-turbo / sdxs) over the pinned wasm-only ORT. */
export function createSdEngine(createWorker: () => Worker): {
	load(opts: EngineLoadOpts): Promise<ImageEngine>;
} {
	registerImageHost('sd', createWorker);
	return hostedImageEngine('sd', 'sd-turbo');
}

/** FLUX.2 [klein] engine over its own jsep-capable ORT pin. */
export function createFlux2Engine(createWorker: () => Worker): {
	load(opts: EngineLoadOpts): Promise<ImageEngine>;
} {
	registerImageHost('flux2', createWorker);
	return hostedImageEngine('flux2', 'flux2-klein-4b');
}

const registered = new Set<string>();
function registerImageHost(family: 'sd' | 'flux2', createWorker: () => Worker): void {
 if (registered.has(family)) return; registered.add(family);
 let loaded: ImageEngine | null = null;
 let key: string | null = null;
 let generation = 0;
 registerBrowserAiHandler(`image:${family}`, {
  kind: 'generate',
  async run(action, value, context) {
   const payload = value as { modelId: string; prompt?: string; seed?: number; width?: number; height?: number };
   // A clear or replace in Settings changes the revision; the next run reloads.
   const revision = await browserModelStore.readReady(imageBrowserModel(imageModelDef(payload.modelId)), async (snapshot) => snapshot.manifest.revision, { signal: context.signal })
    .catch((err: unknown) => { throw err instanceof ModelStoreError && err.code === 'MISSING_FILES' ? new ImageGenError('NO_MODEL', err.message) : err; });
   const requested = `${payload.modelId}:${revision}`;
   const epoch = generation;
   if (!loaded || key !== requested) {
    loaded?.dispose(); loaded = null; key = null; context.state('loading');
    const candidate = await createWorkerEngine(createWorker, `image-${family}`, payload.modelId).load({ modelId: payload.modelId, signal: context.signal, onProgress: (note, fraction) => context.progress({ note, fraction }) });
    if (context.signal.aborted || generation !== epoch) { candidate.dispose(); throw context.signal.reason ?? new Error('AI host handed over'); }
    loaded = candidate;
    key = requested; context.state('loaded');
   }
   context.signal.throwIfAborted();
   if (action === 'load') return undefined;
   return loaded.generate(payload.prompt!, { seed: payload.seed, width: payload.width, height: payload.height, signal: context.signal });
  },
  async capture(value) {
   const result = value as ImageGenResult;
   const canvas = new OffscreenCanvas(result.width, result.height);
   const ctx = canvas.getContext('2d');
   if (!ctx) throw new Error('The AI host cannot encode its image');
   const frame = new ImageData(result.width, result.height); frame.data.set(result.data); ctx.putImageData(frame, 0, 0);
   return canvas.convertToBlob({ type: 'image/png' });
  },
  dispose() { generation++; loaded?.dispose(); loaded = null; key = null; }
 });
}
export function initializeImageBrowserHost(factories: { sd: () => Worker; flux2: () => Worker }): void {
 registerImageHost('sd', factories.sd); registerImageHost('flux2', factories.flux2);
}
function hostedImageEngine(family: 'sd' | 'flux2', fallback: string): { load(opts: EngineLoadOpts): Promise<ImageEngine> } {
 return {
  async load(opts) {
   const modelId = opts.modelId ?? fallback;
   const selection = { modelId };
   const requirements = { webgpu: true, features: ['shader-f16'] };
   await runBrowserAi(`image:${family}`, 'load', selection, modelId, { signal: opts.signal, onProgress: (value) => { const p = value as { note: string; fraction?: number }; opts.onProgress?.(p.note, p.fraction); } }, requirements);
   return {
    modelId,
    generate(prompt, options) { return runBrowserAi<ImageGenResult>(`image:${family}`, 'generate', { ...selection, prompt, seed: options?.seed, width: options?.width, height: options?.height }, modelId, { ...options?.browserHost, signal: options?.signal }, requirements); },
    dispose() { /* The host owns its model; closing a submitter cannot unload it. */ }
   };
  }
 };
}
