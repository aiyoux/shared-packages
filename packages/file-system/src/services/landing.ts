import type { OpRecord, OpsService, ResultRef } from './ops.js';
import { serviceNames } from './names.js';

export type LandingHandler = (op: OpRecord) => Promise<ResultRef>;
export type LandLock = <T>(name: string, run: () => Promise<T>) => Promise<T>;
/** Refresh under the lock: a stale tab must see another tab's landed transition. */
export function createOpLander(service: Pick<OpsService, 'refresh' | 'get' | 'change'>, handler: LandingHandler,
 lock: LandLock = async (name, run) => await navigator.locks.request(name, {}, run)) {
 return async (id: string): Promise<ResultRef | undefined> => lock(serviceNames.landLock(id), async () => {
  await service.refresh();
  const op = service.get(id);
  if (!op || op.dismissed || (op.state !== 'done' && op.state !== 'landed')) return;
  if (op.state === 'landed') return op.result;
  try {
   const result = await handler(op);
   await service.change(id, (current) => current.state === 'done' ? { ...current, state: 'landed', result, landingError: undefined } : current);
   return result;
  } catch (error) {
   await service.change(id, (current) => current.state === 'done' ? { ...current, landingError: error instanceof Error ? error.message : String(error) } : current);
   return;
  }
 });
}

/** Durable private bytes; this creates no folder in the user's VFS catalog. */
export async function stageOpResult(id: string, blob: Blob): Promise<ResultRef> {
 const root = await navigator.storage.getDirectory();
 const dir = await root.getDirectoryHandle('platform-op-results', { create: true });
 const path = encodeURIComponent(id);
 const file = await dir.getFileHandle(path, { create: true });
 const writable = await file.createWritable();
 try { await writable.write(blob); await writable.close(); }
 catch (error) { await writable.abort(); throw error; }
 return { kind: 'opfs-file', path, contentType: blob.type || 'application/octet-stream' };
}
export async function readOpResult(ref: Extract<ResultRef, { kind: 'opfs-file' }>): Promise<File> {
 const root = await navigator.storage.getDirectory();
 const dir = await root.getDirectoryHandle('platform-op-results');
 return (await dir.getFileHandle(ref.path)).getFile();
}
export async function removeOpResult(ref: Extract<ResultRef, { kind: 'opfs-file' }>): Promise<void> {
 const root = await navigator.storage.getDirectory();
 const dir = await root.getDirectoryHandle('platform-op-results');
 await dir.removeEntry(ref.path);
}
