import { createLiveBus, type LiveBus } from '../live/bus.js';
import { serviceContextId } from '../leaseOwner.js';
import { tabOwner, watchOwner, currentTabDirectory, type Owner } from './owner.js';
import { serviceNames } from './names.js';
import { createRecordStore, type RecordStore } from './store.js';

export type OpKindId = 'copy' | 'extract' | 'compress' | 'encrypt' | 'decrypt' | 'import' | 'send' | 'receive' | 'transcribe' | 'speak' | 'generate' | 'video' | 'audio-tool' | 'chat' | 'agent-access' | 'agent-edit';
export type OpState = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled' | 'stopped' | 'landed';
export type Endpoint = { kind: 'browser' | 'monitor' | 'b2' | 'device' | 'provider'; label: string };
export type OpWhere = { executor: 'this-browser' | 'monitor' | 'device'; from?: Endpoint; to?: Endpoint; route?: 'server' | 'delegated' | 'webrtc' | 'dual-phase' | 'direct' | 'p2p' | 'face'; note?: string };
export type LandingAddress =
 | { kind: 'vfs-folder'; folderId: string | null; name: string }
 | { kind: 'vfs-file'; fileId: string }
 | { kind: 'session'; sessionId: string; app: string }
 | { kind: 'monitor-path'; profileId: string; path: string };
export type ResultRef = { kind: 'vfs-file'; fileId: string; name?: string } | { kind: 'session'; sessionId: string } | { kind: 'monitor-path'; profileId: string; path: string } | { kind: 'opfs-file'; path: string; contentType: string };
export type OpDestination = { driverId: string; endpointKey?: string; parentId: string | null; entryKind?: 'file' | 'folder' };
export type OpRecord = { destination?: OpDestination; id: string; kind: OpKindId; app: string; title: string; owner: Owner; where: OpWhere; state: OpState; error?: string; landing?: LandingAddress; result?: ResultRef; resumable: boolean; createdAt: number; endedAt?: number; dismissed?: number; landingError?: string; monitorAcknowledged?: boolean };
export type OpProgress = { id: string; done: number; total?: number; ahead?: number; note?: string };
export type OpFrame = { kind: 'changed'; id: string } | { kind: 'progress'; progress: OpProgress } | { kind: 'cancel'; id: string } | { kind: 'hello' };
export type StartOp = Pick<OpRecord, 'kind' | 'app' | 'title' | 'where'> & { id?: string; owner?: Owner; landing?: LandingAddress; signal?: AbortSignal; resumable?: boolean; destination?: OpDestination };
export type OpHandle = { id: string; signal: AbortSignal; progress(progress: Omit<OpProgress, 'id'>): void; done(result?: ResultRef, landed?: boolean): Promise<void>; fail(error: unknown): Promise<void>; cancelled(): Promise<void>; onCancelRequest(fn: () => void): () => void };
export const isActiveOp = (op: OpRecord) => op.state === 'queued' || op.state === 'running' || op.state === 'paused';

export function createOpsService(options: {
 ctx: string;
 store: RecordStore<OpRecord>;
 bus: LiveBus<OpFrame>;
 watch?: (owner: Owner, signal: AbortSignal) => Promise<void>;
}) {
 const { ctx, store, bus } = options;
 const records = new Map<string, OpRecord>();
 const progress = new Map<string, OpProgress>();
 const controllers = new Map<string, AbortController>();
 const watches = new Map<string, AbortController>();
 const listeners = new Set<() => void>();
 const cancelRequests = new Set<(op: OpRecord) => void>();
 let disposed = false;
 let refreshTail: Promise<void> = Promise.resolve();
 const watch = options.watch ?? watchOwner;
 function notify() { if (!disposed) for (const fn of listeners) fn(); }
 function observe(op: OpRecord) {
  records.set(op.id, op);
  if (op.owner.kind !== 'tab' || op.owner.ctx === ctx) { watches.get(op.id)?.abort(); watches.delete(op.id); }
  if (!isActiveOp(op)) { watches.get(op.id)?.abort(); watches.delete(op.id); controllers.delete(op.id); return; }
  if (op.owner.kind !== 'tab' || op.owner.ctx === ctx || watches.has(op.id)) return;
  const ctl = new AbortController(); watches.set(op.id, ctl);
  void watch(op.owner, ctl.signal).then(async () => {
   if (disposed || ctl.signal.aborted) return;
   currentTabDirectory()?.markGone(op.owner.kind === 'tab' ? op.owner.ctx : '');
   await change(op.id, (current) => isActiveOp(current) && current.owner.kind === 'tab' && current.owner.ctx === (op.owner as Extract<Owner, {kind: 'tab'}>).ctx
    ? { ...current, state: 'stopped', error: 'Stopped: its tab closed', endedAt: Date.now() } : current);
  }).catch((error) => { if (!ctl.signal.aborted) console.error('Could not watch op owner', error); });
 }
 function refresh(): Promise<void> {
  refreshTail = refreshTail.catch(() => {}).then(async () => {
   if (disposed) return;
   for (const op of await store.list()) observe(op);
   notify();
  });
  return refreshTail;
 }
 async function change(id: string, update: (record: OpRecord) => OpRecord): Promise<void> {
  const next = await store.mutate(id, (current) => current ? update(current) : undefined);
  if (next) { observe(next); notify(); bus.broadcast({ kind: 'changed', id }); }
 }
 const stopBus = bus.onMessage((frame) => {
  if (frame.kind === 'progress') { progress.set(frame.progress.id, frame.progress); notify(); }
  else if (frame.kind === 'cancel') { controllers.get(frame.id)?.abort(); const op = records.get(frame.id); if (op) for (const fn of cancelRequests) fn(op); }
  else if (frame.kind === 'changed') void refresh().catch((error) => console.error('Could not read ops', error));
  else {
   for (const p of progress.values()) if (controllers.has(p.id)) bus.broadcast({ kind: 'progress', progress: p });
  }
 });
 const ready = refresh();
 bus.broadcast({ kind: 'hello' });
 return {
  ready,
  refresh,
  all: () => [...records.values()],
  list: () => [...records.values()].filter((op) => !op.dismissed).sort((a, b) => b.createdAt - a.createdAt),
  get: (id: string) => records.get(id),
  progressOf: (id: string) => progress.get(id),
  /** `broadcast: false` when every tab already receives the same tick (monitor job frames). */
  reportProgress(id: string, value: Omit<OpProgress, 'id'>, opts: { broadcast?: boolean } = {}) { const next = { ...value, id }; progress.set(id, next); notify(); if (opts.broadcast !== false) bus.broadcast({ kind: 'progress', progress: next }); },
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  async start(input: StartOp): Promise<OpHandle> {
   await ready;
   if (input.signal?.aborted) throw input.signal.reason ?? new DOMException('Cancelled', 'AbortError');
   const owner = input.owner ?? await tabOwner();
   // serviceContextId confirms the creation lock even for monitor submissions.
   if (owner.kind === 'tab' && owner.ctx !== ctx) throw new Error('A tab cannot start an op owned by another tab');
   const id = input.id ?? crypto.randomUUID();
   const ctl = new AbortController();
   const cancelListeners = new Set<() => void>();
   ctl.signal.addEventListener('abort', () => { for (const fn of cancelListeners) fn(); }, { once: true });
   const abort = () => ctl.abort(input.signal?.reason);
   input.signal?.addEventListener('abort', abort, { once: true });
   if (controllers.has(id)) { input.signal?.removeEventListener('abort', abort); throw new Error(`Operation ${id} already exists`); }
   if (input.signal?.aborted) { input.signal.removeEventListener('abort', abort); throw input.signal.reason; }
   controllers.set(id, ctl);
   try {
    const op = await store.mutate(id, (current) => {
     if (current) throw new Error(`Operation ${id} already exists`);
     return { id, kind: input.kind, app: input.app, title: input.title, where: input.where, owner, landing: input.landing, destination: input.destination, state: 'running', resumable: input.resumable ?? false, createdAt: Date.now() };
    });
    if (!op) throw new Error('Operation was not saved');
    observe(op); notify(); bus.broadcast({ kind: 'changed', id });
   } catch (error) { controllers.delete(id); input.signal?.removeEventListener('abort', abort); throw error; }
   async function finish(state: OpState, result?: ResultRef, error?: string) {
    await change(id, (op) => isActiveOp(op) ? { ...op, state, result, error, endedAt: Date.now() } : op);
    input.signal?.removeEventListener('abort', abort);
   }
   return {
    id, signal: ctl.signal,
    progress(p) { if (disposed || !isActiveOp(records.get(id)!)) return; const next = { ...p, id }; progress.set(id, next); notify(); bus.broadcast({ kind: 'progress', progress: next }); },
    done: (result, landed = true) => finish(result && landed ? 'landed' : 'done', result),
    fail: async (error) => {
     const op = records.get(id);
     if (op?.owner.kind === 'monitor' && isActiveOp(op)) {
      const next = { ...progress.get(id), id, done: progress.get(id)?.done ?? 0, note: ctl.signal.aborted ? 'Cancellation requested' : `This tab lost contact: ${error instanceof Error ? error.message : String(error)}` };
      progress.set(id, next); notify(); bus.broadcast({ kind: 'progress', progress: next }); return;
     }
     await finish(ctl.signal.aborted ? 'cancelled' : 'failed', undefined, error instanceof Error ? error.message : String(error));
    },
    cancelled: async () => { const op = records.get(id); if (op?.owner.kind !== 'monitor') await finish('cancelled'); },
    onCancelRequest(fn) { cancelListeners.add(fn); if (ctl.signal.aborted) fn(); return () => { cancelListeners.delete(fn); }; }
   };
  },
  cancel(id: string) { controllers.get(id)?.abort(); const op = records.get(id); if (op) for (const fn of cancelRequests) fn(op); bus.broadcast({ kind: 'cancel', id }); },
  onCancelRequest(fn: (op: OpRecord) => void) { cancelRequests.add(fn); return () => { cancelRequests.delete(fn); }; },
  async importMonitor(record: OpRecord) {
   if (record.owner.kind !== 'monitor') throw new Error('Only monitor job records may be reconciled');
   const known = records.get(record.id);
   if (known && (known.dismissed || known.state === 'landed' || (known.owner.kind === 'monitor' && known.owner.profileId === record.owner.profileId && known.owner.jobId === record.owner.jobId && known.state === record.state && known.error === record.error && (!record.result || known.result)))) return;
   const next = await store.mutate(record.id, (current) => {
    if (!current) return record;
    if (current.dismissed || current.state === 'landed') return current;
    return { ...record, ...current, owner: record.owner, state: current.state === 'done' && current.result ? current.state : record.state, result: current.result ?? record.result, error: record.error, endedAt: record.endedAt ?? current.endedAt };
   });
   if (next) { observe(next); notify(); bus.broadcast({ kind: 'changed', id: record.id }); }
  },
  dismiss: (id: string) => change(id, (op) => isActiveOp(op) ? op : { ...op, dismissed: op.dismissed ?? Date.now() }),
  async dismissFinished() { for (const op of records.values()) if (!isActiveOp(op)) await change(op.id, (current) => ({ ...current, dismissed: current.dismissed ?? Date.now() })); },
  change,
  async dispose() { disposed = true; for (const ctl of watches.values()) ctl.abort(); watches.clear(); stopBus(); bus.destroy(); listeners.clear(); cancelRequests.clear(); await store.close(); }
 };
}
export type OpsService = ReturnType<typeof createOpsService>;
let singleton: Promise<OpsService> | null = null;
export function opsService(): Promise<OpsService> {
 return singleton ??= serviceContextId().then(async (ctx) => {
  const service = createOpsService({ ctx, store: createRecordStore<OpRecord>(serviceNames.opsDb), bus: createLiveBus(serviceNames.ops, ctx, { isImmediate: (frame) => frame.kind === 'progress' }) });
  await service.ready; return service;
 }).catch((error) => { singleton = null; throw error; });
}
export async function startOp(input: StartOp): Promise<OpHandle> { return (await opsService()).start(input); }
