import { describe, expect, it } from 'vitest';
import { createWorkerRpc, resetInferenceWorkers } from './workerRpc.js';

class FakeWorker {
 onmessage: ((event: MessageEvent) => void) | null = null;
 onerror: ((event: ErrorEvent) => void) | null = null;
 terminated = false;
 failClone = false;
 requests: Array<{ id: number; op: string }> = [];
 postMessage(message: { id: number; op: string }) { if (this.failClone) throw new DOMException('Cannot clone', 'DataCloneError'); this.requests.push(message); }
 terminate() { this.terminated = true; }
 reply(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
describe('host inference worker bridge', () => {
 it('streams progress without completing the call and resolves its transferred result', async () => {
  const worker = new FakeWorker(); const progress: unknown[] = [];
  const rpc = createWorkerRpc(() => worker as unknown as Worker, 'test-progress', () => {});
  const result = rpc.call('transcribe', {}, [], (value) => progress.push(value));
  worker.reply({ id: 1, progress: { doneChunks: 1, chunks: 2 } });
  worker.reply({ id: 1, ok: true, result: 'words' });
  expect(await result).toBe('words'); expect(progress).toEqual([{ doneChunks: 1, chunks: 2 }]); rpc.reset();
 });
 it('reset terminates just the chosen backend and fails its active calls', async () => {
  const first = new FakeWorker(); const second = new FakeWorker();
  const a = createWorkerRpc(() => first as unknown as Worker, 'test-first', () => {});
  const b = createWorkerRpc(() => second as unknown as Worker, 'test-second', () => {});
  const resultA = a.call('load', {}); const resultB = b.call('load', {});
  const failed = expect(resultA).rejects.toMatchObject({ code: 'CANCELLED' });
  resetInferenceWorkers('test-first'); await failed;
  expect(first.terminated).toBe(true); expect(second.terminated).toBe(false);
  second.reply({ id: 1, ok: true, result: 'still alive' }); expect(await resultB).toBe('still alive'); b.reset();
 });
 it('failed post rejects immediately and does not leave a waiter', async () => {
  const worker = new FakeWorker(); worker.failClone = true;
  const rpc = createWorkerRpc(() => worker as unknown as Worker, 'test-clone', () => {});
  await expect(rpc.call('load', {})).rejects.toMatchObject({ name: 'DataCloneError' }); rpc.reset();
 });
 it('an old worker error cannot terminate or reject its replacement', async () => {
  const stale = new FakeWorker(); const fresh = new FakeWorker();
  let created = 0;
  const rpc = createWorkerRpc(() => (created++ === 0 ? stale : fresh) as unknown as Worker, 'test-stale-error', () => {});
  const original = rpc.call('load', {});
  const cancelled = expect(original).rejects.toMatchObject({ code: 'CANCELLED' });
  rpc.reset(); await cancelled;
  const replacement = rpc.call('load', {});
  stale.onerror?.({ preventDefault() {}, message: 'queued error from terminated worker' } as ErrorEvent);
  expect(fresh.terminated).toBe(false);
  fresh.reply({ id: fresh.requests[0]!.id, ok: true, result: 'loaded' });
  await expect(replacement).resolves.toBe('loaded'); rpc.reset();
 });

});
