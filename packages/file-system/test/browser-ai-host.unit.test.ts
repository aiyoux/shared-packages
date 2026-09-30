import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserHostCore, type BrowserHostFrame, type BrowserHostRequest, type BrowserHostContext } from '../src/ai/browserHostCore.ts';
import type { Election, LeaderRef } from '../src/live/election.ts';
import type { LiveBus } from '../src/live/bus.ts';
import { checkBrowserAiCapabilities } from '../src/ai/browserHost.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness(execute: (request: BrowserHostRequest, context: BrowserHostContext) => Promise<unknown>) {
 let leader: LeaderRef | null = { id: 'election-a', tabId: 'a', term: 1 };
 const changes = new Map<string, Set<() => void>>();
 const receivers = new Map<string, (frame: BrowserHostFrame, sender: string) => void>();
 const abandoned = new Set<string>();
 const frames: BrowserHostFrame[] = [];
 function make(id: string) {
  const listeners = new Set<() => void>(); changes.set(id, listeners);
  const election = {
   get leader() { return leader; }, get isLeader() { return leader?.tabId === id; }, tabId: id,
   onChange(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }, destroy() { changes.delete(id); }
  } as unknown as Election;
  const bus: LiveBus<BrowserHostFrame> = {
   broadcast(frame) { frames.push(frame); queueMicrotask(() => { for (const [target, receive] of receivers) if (target !== id) receive(frame, id); }); },
   broadcastImmediate(frame) { this.broadcast(frame); },
   onMessage(fn) { receivers.set(id, fn); return () => receivers.delete(id); }, onSenderGone() { return () => {}; }, destroy() { receivers.delete(id); }
  };
  return createBrowserHostCore({ election, bus, execute, abandon() { abandoned.add(id); } });
 }
 const a = make('a'); const b = make('b');
 return { a, b, frames, abandoned, move(tabId: string | null, term = 2) { leader = tabId ? { id: `election-${tabId}`, tabId, term } : null; for (const listeners of changes.values()) for (const fn of listeners) fn(); }, close() { a.destroy(); b.destroy(); } };
}
const request = (id = 'run'): BrowserHostRequest => ({ id, handler: 'test', model: 'model', action: 'generate', payload: new Float32Array([1, 2, 3]) });

test('one host receives one cloned input and streams progress before its result', async () => {
 const inputs: unknown[] = [];
 const h = harness(async (req, context) => { inputs.push(req.payload); context.state('loading'); context.progress({ done: 1 }); context.state('loaded'); return new Uint8Array([4, 5]); });
 try {
  const progress: unknown[] = [];
  const result = await h.b.call<Uint8Array>(request(), { onProgress: (p) => progress.push(p) });
  assert.deepEqual(result, new Uint8Array([4, 5])); assert.equal(inputs.length, 1); assert.deepEqual(progress, [{ done: 1 }]);
  assert.equal(h.frames.filter((f) => f.kind === 'submit').length, 1);
  assert.equal(h.b.models.model, 'loaded');
 } finally { h.close(); }
});

test('cancel from a non-host reaches the running host signal', async () => {
 let hostSignal: AbortSignal | undefined;
 const h = harness(async (_req, context) => { hostSignal = context.signal; return new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })); });
 try {
  const controller = new AbortController();
  const run = h.b.call(request(), { signal: controller.signal });
  const rejected = assert.rejects(run, { name: 'AbortError' });
  await tick(); assert.ok(hostSignal); controller.abort(); await rejected; await tick(); assert.equal(hostSignal.aborted, true);
 } finally { h.close(); }
});

test('host term loss stops running requests without resubmitting and unloads old host', async () => {
 let signal: AbortSignal | undefined; let calls = 0;
 const h = harness(async (_req, context) => { calls++; signal = context.signal; return new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })); });
 try {
  const run = h.b.call(request()); const rejected = assert.rejects(run, /Stopped: its AI host tab/);
  await tick(); h.move('b'); await rejected; await tick();
  assert.equal(signal?.aborted, true); assert.ok(h.abandoned.has('a')); assert.equal(calls, 1); assert.deepEqual(h.b.models, {});
 } finally { h.close(); }
});

test('new host handles next run and loads on demand after handover', async () => {
 let calls = 0;
 const h = harness(async () => ++calls);
 try {
  assert.equal(await h.b.call(request('first')), 1); h.move('b');
  assert.equal(await h.a.call(request('second')), 2);
  const submits = h.frames.filter((f) => f.kind === 'submit');
  assert.equal(submits.length, 2); assert.equal(submits[1].kind === 'submit' && submits[1].target.term, 2);
 } finally { h.close(); }
});

test('submitting context closes but host finishes and captures its result', async () => {
 let finish: ((value: unknown) => void) | undefined; let captured = false;
 const h = harness(async () => { await new Promise((resolve) => { finish = resolve; }); captured = true; return 'saved'; });
 try {
  const run = h.b.call(request()); const rejected = assert.rejects(run, /client is closed/);
  await tick(); h.b.destroy(); await rejected; finish!('done'); await tick(); assert.equal(captured, true);
 } finally { h.close(); }
});

test('explicit refusal reaches caller; no fallback runs elsewhere', async () => {
 let calls = 0;
 const h = harness(async () => { calls++; throw new Error('Host lacks shader-f16'); });
 try { await assert.rejects(h.b.call(request()), /Host lacks shader-f16/); assert.equal(calls, 1); }
 finally { h.close(); }
});

test('uncloneable request fails before publication', async () => {
 const h = harness(async () => assert.fail('must not execute'));
 try { await assert.rejects(h.b.call({ ...request(), payload: () => {} }), { name: 'DataCloneError' }); assert.equal(h.frames.filter((f) => f.kind === 'submit').length, 0); }
 finally { h.close(); }
});

test('feature checks reject the elected host missing shader-f16', async () => {
 const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
 Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: { requestAdapter: async () => ({ features: new Set<string>() }) } } });
 try { await assert.rejects(checkBrowserAiCapabilities({ webgpu: true, features: ['shader-f16'] }), /host tab lacks WebGPU feature shader-f16/); }
 finally { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete (globalThis as { navigator?: unknown }).navigator; }
});
