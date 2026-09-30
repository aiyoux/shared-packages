import type { Election, LeaderRef } from '../live/election.js';
import type { LiveBus } from '../live/bus.js';

export type BrowserModelState = 'loading' | 'loaded' | 'not-loaded';
export type BrowserHostRequest = {
 id: string; handler: string; action: string; payload: unknown; model: string;
 output?: unknown; requirements?: { webgpu?: boolean; features?: string[] };
};
export type BrowserHostFrame =
 | { kind: 'submit'; target: LeaderRef; request: BrowserHostRequest }
 | { kind: 'cancel'; target: LeaderRef; id: string }
 | { kind: 'progress'; target: string; host: LeaderRef; id: string; value: unknown }
 | { kind: 'result'; target: string; host: LeaderRef; id: string; value: unknown }
 | { kind: 'refused'; target: string; host: LeaderRef; id: string; reason: string }
 | { kind: 'state'; host: LeaderRef; models: Record<string, BrowserModelState> }
 | { kind: 'hello' };
export type BrowserHostContext = { signal: AbortSignal; progress(value: unknown): void; state(state: BrowserModelState, model?: string): void };
const same = (a: LeaderRef | null, b: LeaderRef | null) => !!a && !!b && a.id === b.id && a.term === b.term;

/** The election's term-lock notice is the only host-death detector. A request
 * belongs to one term; it is never silently replayed on the next host. */
export function createBrowserHostCore(options: {
 election: Election; bus: LiveBus<BrowserHostFrame>;
 execute(request: BrowserHostRequest, context: BrowserHostContext): Promise<unknown>;
 abandon(): void;
}) {
 const { election, bus } = options;
 const pending = new Map<string, { request: BrowserHostRequest; host: LeaderRef | null; resolve(value: unknown): void; reject(error: Error): void; progress?: (value: unknown) => void; cleanup(): void }>();
 const active = new Map<string, { controller: AbortController; sender: string }>();
 const listeners = new Set<() => void>();
 let models: Record<string, BrowserModelState> = {};
 let previous = election.leader;
 let destroyed = false;
 const notify = () => { for (const fn of listeners) fn(); };
 function publish() { if (election.isLeader && election.leader) bus.broadcast({ kind: 'state', host: election.leader, models }); }
 function deliver(frame: BrowserHostFrame, sender: string) {
  if (destroyed) return;
  if (frame.kind === 'hello') { publish(); return; }
  if (frame.kind === 'state') {
   if (sender !== frame.host.tabId || !same(election.leader, frame.host)) return;
   models = frame.models; notify(); return;
  }
  if (frame.kind === 'cancel') {
   if (election.isLeader && same(election.leader, frame.target) && active.get(frame.id)?.sender === sender) active.get(frame.id)?.controller.abort(new DOMException('Cancelled', 'AbortError'));
   return;
  }
  if (frame.kind === 'submit') {
   if (!election.isLeader || !same(election.leader, frame.target) || active.has(frame.request.id)) return;
   const host = election.leader!;
   const request = frame.request;
   const controller = new AbortController();
   const running = { controller, sender }; active.set(request.id, running);
   const reply = (message: BrowserHostFrame) => { if (sender === election.tabId) deliver(message, election.tabId); else bus.broadcast(message); };
   void options.execute(request, {
    signal: controller.signal,
    progress(value) { if (!controller.signal.aborted && same(election.leader, host)) reply({ kind: 'progress', target: sender, host, id: request.id, value }); },
    state(state, model = request.model) { if (same(election.leader, host)) { models = { ...models, [model]: state }; publish(); notify(); } }
   }).then((value) => {
    if (!controller.signal.aborted && same(election.leader, host)) reply({ kind: 'result', target: sender, host, id: request.id, value });
   }).catch((error) => {
    if (same(election.leader, host)) reply({ kind: 'refused', target: sender, host, id: request.id, reason: error instanceof Error ? error.message : String(error) });
   }).finally(() => { if (active.get(request.id) === running) active.delete(request.id); });
   return;
  }
  if (frame.target !== election.tabId || sender !== frame.host.tabId) return;
  const waiter = pending.get(frame.id);
  if (!waiter || !same(waiter.host, frame.host)) return;
  if (frame.kind === 'progress') { waiter.progress?.(frame.value); return; }
  pending.delete(frame.id); waiter.cleanup();
  if (frame.kind === 'result') waiter.resolve(frame.value);
  else waiter.reject(new Error(frame.reason));
 }
 function dispatch() {
  const host = election.leader;
  if (!host) return;
  for (const waiter of pending.values()) {
   if (waiter.host) continue;
   waiter.host = host;
   const frame: BrowserHostFrame = { kind: 'submit', target: host, request: waiter.request };
   if (election.isLeader) deliver(frame, election.tabId); else bus.broadcast(frame);
  }
 }
 const offBus = bus.onMessage(deliver);
 const offElection = election.onChange(() => {
  const newHost = election.leader && !same(previous, election.leader);
  if (previous && !same(previous, election.leader)) {
   for (const [id, waiter] of pending) if (same(waiter.host, previous)) {
    pending.delete(id); waiter.cleanup(); waiter.reject(new Error('Stopped: its AI host tab closed or handed over'));
   }
   if (previous.tabId === election.tabId) {
    for (const run of active.values()) run.controller.abort(new Error('AI host handed over'));
    active.clear(); options.abandon();
   }
   models = {};
  }
  previous = election.leader; dispatch(); publish(); notify();
  // Election and inference use distinct channels. A status reply to the
  // initial hello may arrive before the leader announcement and be fenced.
  // Ask again once the exact term is known; no grace period or polling.
  if (newHost && !election.isLeader) bus.broadcast({ kind: 'hello' });
 });
 bus.broadcast({ kind: 'hello' });
 return {
  get host() { return election.leader; },
  get models() { return { ...models }; },
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  call<T>(request: BrowserHostRequest, opts: { signal?: AbortSignal; onProgress?: (value: unknown) => void } = {}): Promise<T> {
   if (destroyed) return Promise.reject(new Error('AI host client is closed'));
   if (opts.signal?.aborted) return Promise.reject(opts.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
   // Validate before publication. LiveBus reports clone failures to its ordering
   // layer; an inference caller also needs the actual error instead of waiting.
   try { structuredClone(request); } catch (error) { return Promise.reject(error); }
   return new Promise<T>((resolve, reject) => {
    const abort = () => {
     const waiter = pending.get(request.id); if (!waiter) return;
     pending.delete(request.id); waiter.cleanup();
     if (waiter.host) {
      const frame: BrowserHostFrame = { kind: 'cancel', target: waiter.host, id: request.id };
      if (election.isLeader && same(election.leader, waiter.host)) deliver(frame, election.tabId); else bus.broadcast(frame);
     }
     reject(opts.signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
    };
    pending.set(request.id, { request, host: null, resolve: resolve as (value: unknown) => void, reject, progress: opts.onProgress, cleanup: () => opts.signal?.removeEventListener('abort', abort) });
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) abort(); else dispatch();
   });
  },
  destroy() {
   destroyed = true; offElection(); offBus();
   for (const waiter of pending.values()) { waiter.cleanup(); waiter.reject(new Error('AI host client is closed')); }
   pending.clear();
   for (const run of active.values()) run.controller.abort(new Error('AI host closed'));
   active.clear(); options.abandon(); listeners.clear(); election.destroy(); bus.destroy();
  }
 };
}
