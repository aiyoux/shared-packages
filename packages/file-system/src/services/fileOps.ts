/** File-manager adapters. Transfer blob retention stays in transferRegistry. */
import type { TransferProgress } from '../transferRegistry.js';
import { startOp, type OpHandle, type OpKindId, type StartOp, type ResultRef } from './ops.js';

const handles = new Map<string, OpHandle>();
const results = new Map<string, ResultRef>();
export function setFileOpResult(id: string, result: ResultRef): void { results.set(id, result); }
const latest = new Map<string, TransferProgress>();
let starter = startOp;
const aborts = new Map<string, AbortController>();

export async function beginFileOp(id: string, input: Omit<StartOp, 'id'>): Promise<void> {
 const handle = await starter({ ...input, id });
 handles.set(id, handle);
 const buffered = latest.get(id);
 if (buffered) reportFileOp(buffered);
 handle.onCancelRequest(() => aborts.get(id)?.abort());
}
export function attachFileOpAbort(id: string, controller: AbortController): void {
 aborts.set(id, controller);
 if (handles.get(id)?.signal.aborted) controller.abort();
}
export function abortFileOp(id: string): void { aborts.get(id)?.abort(); }

/** Progress is transient; only completion changes persistent state. */
export function reportFileOp(progress: TransferProgress): void {
 progress = { ...latest.get(progress.id), ...Object.fromEntries(Object.entries(progress).filter(([, value]) => value !== undefined)) } as TransferProgress;
 latest.set(progress.id, progress);
 const baseId = progress.id.replace(/:(remote|wire)$/, '');
 const handle = handles.get(baseId);
 if (baseId !== progress.id && handle) {
  const remote = latest.get(`${baseId}:remote`);
  const wire = latest.get(`${baseId}:wire`);
  handle.progress({ done: wire?.transferred ?? 0, ahead: remote?.transferred ?? 0, total: Math.max(remote?.size ?? 0, wire?.size ?? 0), note: progress.hopNote });
  if (progress.status === 'failed' || progress.status === 'cancelled' || (remote?.done && wire?.done)) {
   const finish = progress.status === 'failed' ? handle.fail(progress.error ?? 'Copy failed') : progress.status === 'cancelled' ? handle.cancelled() : handle.done(results.get(baseId));
   void finish.catch((error) => console.error('Could not finish operation', error));
   handles.delete(baseId); results.delete(baseId); aborts.delete(baseId);
  }
  return;
 }
 if (!handle) return;
 handle.progress({ done: progress.transferred, total: progress.size, note: progress.hopNote });
 if (!progress.done && progress.status !== 'failed' && progress.status !== 'cancelled') return;
 const finish = progress.status === 'cancelled' ? handle.cancelled() : progress.status === 'failed' ? handle.fail(progress.error ?? 'Operation failed') : handle.done(results.get(progress.id));
 void finish.catch((error) => console.error('Could not finish operation', error));
 handles.delete(progress.id); results.delete(progress.id); aborts.delete(progress.id);
}
/** UI diagnostics and unit-adapter seam; durable/global lists always read opsService. */
export function listFileOpProgress(): TransferProgress[] { return [...latest.values()]; }
export function resetFileOpsForTest(next?: typeof startOp) { handles.clear(); results.clear(); latest.clear(); aborts.clear(); starter = next ?? startOp; }
export async function beginArchiveOp(id: string, kind: OpKindId, title: string, folderId: string | null, signal: AbortSignal, options: { driverId: string; endpointKey?: string; executor: 'this-browser' | 'monitor'; note: string } = { driverId: 'local', executor: 'this-browser', note: 'This tab' }) {
 await beginFileOp(id, { kind, app: 'files', title, where: { executor: options.executor, note: options.note }, landing: options.driverId === 'local' ? { kind: 'vfs-folder', folderId, name: title } : undefined, destination: { driverId: options.driverId, endpointKey: options.endpointKey, parentId: folderId }, signal });
}
