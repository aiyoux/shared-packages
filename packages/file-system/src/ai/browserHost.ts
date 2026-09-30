import { createElection, getTabId } from '../live/election.js';
import { createLiveBus } from '../live/bus.js';
import { startOp, opsService, type LandingAddress, type OpKindId, type StartOp } from '../services/ops.js';
import { stageOpResult } from '../services/landing.js';
import { createBrowserHostCore, type BrowserHostContext, type BrowserHostFrame, type BrowserHostRequest } from './browserHostCore.js';

export type BrowserAiOutput = { landing: LandingAddress; title?: string; chat?: StartOp['chat'] };
export type BrowserAiRunOptions = Partial<BrowserAiOutput> & { outputExtension?: string; signal?: AbortSignal; onProgress?: (value: unknown) => void };
export type BrowserAiHandler = {
 kind: Extract<OpKindId, 'transcribe' | 'speak' | 'generate' | 'chat' | 'audio-tool'>;
 run(action: string, payload: unknown, context: BrowserHostContext): Promise<unknown>;
 capture(result: unknown): Promise<Blob> | Blob;
 reply?(result: unknown, action: string): unknown;
 dispose(): void;
};
const handlers = new Map<string, BrowserAiHandler>();
const tails = new Map<string, Promise<unknown>>();
const loadedModels = new Map<string, string>();
let configuration: { chooseOutput?: (kind: OpKindId, title: string, extension?: string) => Promise<LandingAddress | null>; land?: (id: string) => Promise<unknown> } = {};
let singleton: ReturnType<typeof createBrowserHostCore> | null = null;
export function configureBrowserAiHost(config: typeof configuration): void { configuration = config; }
export function registerBrowserAiHandler(id: string, handler: BrowserAiHandler): void { handlers.set(id, handler); }

/** Checks only the elected host. A capable submitting tab is never substituted. */
export async function checkBrowserAiCapabilities(requirements?: BrowserHostRequest['requirements']): Promise<void> {
 if (!requirements?.webgpu && !requirements?.features?.length) return;
 const gpu = (globalThis.navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: { has(feature: string): boolean } } | null> } } | undefined)?.gpu;
 if (!gpu) throw new Error('The AI host tab has no WebGPU support');
 const adapter = await gpu.requestAdapter();
 if (!adapter) throw new Error('The AI host tab has no WebGPU adapter');
 for (const feature of requirements.features ?? []) if (!adapter.features.has(feature)) throw new Error(`The AI host tab lacks WebGPU feature ${feature}`);
}

async function execute(request: BrowserHostRequest, context: BrowserHostContext): Promise<unknown> {
 const handler = handlers.get(request.handler);
 if (!handler) throw new Error(`The AI host cannot run ${request.handler}`);
 await checkBrowserAiCapabilities(request.requirements);
 context.signal.throwIfAborted();
 if (request.action === 'probe') return true;
 const loading = request.action === 'load';
 const output = request.output as BrowserAiOutput | undefined;
 if (!loading && !output?.landing) throw new Error('Choose an output destination before starting browser AI');
 const op = loading ? undefined : await startOp({ kind: handler.kind, app: handler.kind, title: output?.title ?? request.model, landing: output!.landing, chat: output?.chat, signal: context.signal, where: { executor: 'this-browser', note: 'Shared browser AI host' } });
 const signal = op?.signal ?? context.signal;
 let running = false;
 let inferenceCompleted = false;
 let opCompleted = false;
 const stop = () => { if (running) handler.dispose(); };
 signal.addEventListener('abort', stop, { once: true });
 const prior = tails.get(request.handler) ?? Promise.resolve();
 const task = prior.catch(() => {}).then(async () => {
  signal.throwIfAborted(); running = true;
  const previousModel = loadedModels.get(request.handler);
  if (previousModel && previousModel !== request.model) context.state('not-loaded', previousModel);
  loadedModels.set(request.handler, request.model);
  try {
   const result = await handler.run(request.action, request.payload, { ...context, signal, progress(value) {
    context.progress(value);
    const p = value as { done?: number; total?: number; doneChunks?: number; chunks?: number } | null;
    op?.progress({ done: p?.done ?? p?.doneChunks ?? 0, total: p?.total ?? p?.chunks });
   } });
   signal.throwIfAborted();
   inferenceCompleted = true;
   if (op) {
    const ref = await stageOpResult(op.id, await handler.capture(result));
    signal.throwIfAborted();
    await op.done(ref, false);
    opCompleted = true;
    // Result capture is complete before a reply, even if the submitting tab
    // closed. A landing failure leaves its durable result available in Ops.
    const requireChatLanding = handler.kind === 'chat' && output?.landing.kind === 'session' && !!output.chat;
    try {
     const landed = await configuration.land?.(op.id);
     if (requireChatLanding && !landed) throw new Error('Reply finished; its saved chat destination is unavailable. Open Ops to review it.');
    } catch (error) {
     if (requireChatLanding) throw error;
     console.warn('Browser AI result awaits Save to…', error);
    }
   }
   return handler.reply ? handler.reply(result, request.action) : result;
  } finally { running = false; }
 });
 tails.set(request.handler, task);
 try { return await task; }
 catch (error) {
  if (!inferenceCompleted || signal.aborted) context.state('not-loaded');
  if (op && !opCompleted) {
   if (context.signal.aborted && (context.signal.reason as { name?: string } | undefined)?.name === 'AbortError') await op.cancelled();
   else if (context.signal.aborted) await (await opsService()).change(op.id, (current) => ['running', 'queued', 'paused'].includes(current.state) ? { ...current, state: 'stopped', error: 'Stopped: its AI host handed over', endedAt: Date.now() } : current);
   else await op.fail(error);
  }
  throw error;
 } finally { signal.removeEventListener('abort', stop); if (tails.get(request.handler) === task) tails.delete(request.handler); }
}

export function browserAiHost() {
 if (!singleton) {
  if (typeof window === 'undefined' || !globalThis.navigator?.locks || typeof BroadcastChannel === 'undefined') throw new Error('Shared browser AI requires Web Locks and BroadcastChannel in this browser');
  const tabId = getTabId();
  singleton = createBrowserHostCore({
   election: createElection('ai-host'), bus: createLiveBus<BrowserHostFrame>('scratchpad:ai-host', tabId), execute,
   abandon() { for (const handler of handlers.values()) handler.dispose(); tails.clear(); loadedModels.clear(); }
  });
 }
 return singleton;
}

export async function runBrowserAi<T>(handler: string, action: string, payload: unknown, model: string, options: BrowserAiRunOptions = {}, requirements?: BrowserHostRequest['requirements']): Promise<T> {
 options.signal?.throwIfAborted();
 let landing = options.landing;
 const entry = handlers.get(handler);
 if (action !== 'load' && action !== 'probe' && !landing) {
  if (!entry || !configuration.chooseOutput) throw new Error('Choose an output destination before starting browser AI');
  landing = await configuration.chooseOutput(entry.kind, options.title ?? model, options.outputExtension) ?? undefined;
  if (!landing) throw new DOMException('Output selection cancelled', 'AbortError');
 }
 options.signal?.throwIfAborted();
 return browserAiHost().call<T>({ id: crypto.randomUUID(), handler, action, payload, model, requirements, output: landing ? { landing, title: options.title, chat: options.chat } : undefined }, options);
}

export type { BrowserModelState, BrowserHostContext } from './browserHostCore.js';
