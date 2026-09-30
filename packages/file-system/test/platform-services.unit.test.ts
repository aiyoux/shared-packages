import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createRecordStore } from '../src/services/store.ts';
import { createOpsService, type OpRecord, type OpFrame } from '../src/services/ops.ts';
import { createNotificationsService, shouldToastNotification, type NotificationRecord } from '../src/services/notifications.ts';
import { createTabDirectory, ownerLiveness, watchOwner, ownerLabel } from '../src/services/owner.ts';
import { contextLockName } from '../src/leaseOwner.ts';
import type { LiveBus } from '../src/live/bus.ts';
import { installLockPolyfill } from './live-locks-harness.ts';
import { createOpLander, type LandLock } from '../src/services/landing.ts';

function network<T>() {
 const clients = new Set<(msg: T, sender: string) => void>();
 return (id: string): LiveBus<T> => {
  const handlers = new Set<(msg: T, sender: string) => void>();
  const receive = (msg: T, sender: string) => { if (id !== sender) for (const fn of handlers) fn(structuredClone(msg), sender); };
  clients.add(receive);
  const post = (msg: T) => { queueMicrotask(() => { for (const fn of clients) fn(msg, id); }); };
  return { broadcast: post, broadcastImmediate: post, onMessage(fn) { handlers.add(fn); return () => { handlers.delete(fn); }; }, onSenderGone() { return () => {}; }, destroy() { clients.delete(receive); } };
 };
}
function until(service: { subscribe(fn: () => void): () => void }, predicate: () => boolean): Promise<void> {
 if (predicate()) return Promise.resolve();
 return new Promise((resolve) => { const stop = service.subscribe(() => { if (predicate()) { stop(); resolve(); } }); });
}
const owner = { kind: 'tab' as const, ctx: 'a', label: 'Files · Project' };
const input = { kind: 'copy' as const, app: 'files', title: 'a.txt', owner, where: { executor: 'this-browser' as const } };

function opsPair() {
 const factory = new IDBFactory(); const bus = network<OpFrame>();
 const gone = new Map<string, () => void>();
 const watch = (recordOwner: typeof owner, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  gone.set(recordOwner.ctx, resolve);
  signal.addEventListener('abort', () => reject(new DOMException('Disposed', 'AbortError')), { once: true });
 });
 const a = createOpsService({ ctx: 'a', store: createRecordStore<OpRecord>('ops', factory), bus: bus('a'), watch: watch as never });
 const b = createOpsService({ ctx: 'b', store: createRecordStore<OpRecord>('ops', factory), bus: bus('b'), watch: watch as never });
 return { a, b, gone, factory };
}

describe('origin operations', () => {
 it('progress reaches another tab without writing storage and cancellation routes to its owner', async () => {
  const { a, b, factory } = opsPair();
  await Promise.all([a.ready, b.ready]);
  const handle = await a.start(input);
  await until(b, () => !!b.get(handle.id));
  handle.progress({ done: 12, total: 50, ahead: 20 });
  await until(b, () => b.progressOf(handle.id)?.done === 12);
  const stored = await createRecordStore<OpRecord>('ops', factory).list();
  assert.equal('progress' in stored[0], false);
  assert.equal(stored[0].state, 'running');
  b.cancel(handle.id);
  await new Promise<void>((resolve) => { if (handle.signal.aborted) resolve(); else handle.signal.addEventListener('abort', () => resolve(), { once: true }); });
  await handle.cancelled();
  await until(b, () => b.get(handle.id)?.state === 'cancelled');
  await Promise.all([a.dispose(), b.dispose()]);
 });
 it('owner death stops the operation and late completion cannot undo it', async () => {
  const { a, b, gone } = opsPair();
  await Promise.all([a.ready, b.ready]);
  const handle = await a.start(input);
  await until(b, () => !!b.get(handle.id));
  gone.get('a')!();
  await until(b, () => b.get(handle.id)?.state === 'stopped');
  await handle.done();
  assert.equal(a.get(handle.id)?.state, 'stopped');
  await Promise.all([a.dispose(), b.dispose()]);
 });
 it('dismissal survives stale completion and reload; every id is retained', async () => {
  const { a, b, factory } = opsPair();
  await Promise.all([a.ready, b.ready]);
  const handle = await a.start(input); await handle.done(); await b.dismiss(handle.id); await handle.done();
  const stored = await createRecordStore<OpRecord>('ops', factory).list();
  assert.ok(stored[0].dismissed);
  await until(a, () => a.list().length === 0);
  await Promise.all([a.dispose(), b.dispose()]);
 });
 it('rejects an id collision and an attempt to claim another tab as owner', async () => {
  const { a, b } = opsPair(); await Promise.all([a.ready, b.ready]);
  await a.start({ ...input, id: 'fixed' });
  await assert.rejects(a.start({ ...input, id: 'fixed' }), /already exists/);
  await assert.rejects(b.start(input), /another tab/);
  await Promise.all([a.dispose(), b.dispose()]);
 });
});

describe('origin notifications', () => {
 it('emits once across tabs and read/dismiss survives a stale emitter', async () => {
  const factory = new IDBFactory(); const bus = network<{ kind: 'changed'; id: string }>();
  const a = createNotificationsService(createRecordStore<NotificationRecord>('notices', factory), bus('a'));
  const b = createNotificationsService(createRecordStore<NotificationRecord>('notices', factory), bus('b'));
  await Promise.all([a.ready, b.ready]);
  const notice: NotificationRecord = { id: 'op:x:finished', source: { kind: 'op', opId: 'x' }, level: 'success', title: 'Copy finished', createdAt: 1 };
  let arrivals = 0; a.onArrival(() => { arrivals++; });
  await Promise.all([a.emit(notice), b.emit(notice)]);
  assert.equal((await createRecordStore<NotificationRecord>('notices', factory).list()).length, 1);
  assert.equal(arrivals, 1);
  await b.read(notice.id); await a.emit(notice);
  assert.ok(a.list()[0].read);
  await b.dismiss(notice.id); await a.emit(notice);
  assert.equal(a.list().length, 0);
  await Promise.all([a.dispose(), b.dispose()]);
 });
 it('toasts only when visible and focused', () => {
  assert.equal(shouldToastNotification('hidden', true), false);
  assert.equal(shouldToastNotification('visible', false), false);
  assert.equal(shouldToastNotification('visible', true), true);
 });
});

describe('owners', () => {
 it('resolves on lock release, detects a free lock at boot, and abort never reports death', async () => {
  const harness = installLockPolyfill();
  Object.assign(navigator.locks, { query: async () => ({ held: [...harness.held].filter(([, live]) => live).map(([name]) => ({ name })) }) });
  let release!: () => void;
  const held = navigator.locks.request(contextLockName('a'), {}, () => new Promise<void>((resolve) => { release = resolve; }));
  await Promise.resolve();
  assert.equal(await ownerLiveness(owner), 'alive');
  let gone = false;
  const watching = watchOwner(owner).then(() => { gone = true; });
  await Promise.resolve(); assert.equal(gone, false);
  const controller = new AbortController();
  const abandoned = watchOwner(owner, controller.signal);
  controller.abort(); await assert.rejects(abandoned, { name: 'AbortError' });
  assert.equal(gone, false);
  release(); await held; await watching;
  assert.equal(await ownerLiveness(owner), 'gone');
  harness.reset();
 });
 it('keeps the published label after death and states background visibility', () => {
  const tabs = createTabDirectory('a', network<any>()('a'));
  tabs.update('Creative · Sketch 3', true);
  assert.match(ownerLabel(owner, 'b', tabs), /background tab.*Sketch 3/);
  tabs.markGone('a');
  assert.equal(tabs.labelOf('a'), 'Creative · Sketch 3');
  assert.equal(ownerLabel(owner, 'b', tabs), 'Stopped: its tab closed');
  tabs.dispose();
 });
});

describe('operation landing', () => {
 it('refreshes under a shared lock and lands once across stale tabs', async () => {
  const { a, b } = opsPair(); await Promise.all([a.ready, b.ready]);
  const handle = await a.start({ ...input, landing: { kind: 'vfs-folder', folderId: null, name: 'a.txt' } });
  await handle.done({ kind: 'opfs-file', path: handle.id, contentType: 'text/plain' }, false);
  let writes = 0; let tail: Promise<unknown> = Promise.resolve();
  const names: string[] = [];
  const serial: LandLock = (name, run) => { names.push(name); const next = tail.then(run); tail = next.catch(() => {}); return next; };
  const handler = async () => { writes++; return { kind: 'vfs-file' as const, fileId: 'saved' }; };
  const [first, second] = await Promise.all([createOpLander(a, handler, serial)(handle.id), createOpLander(b, handler, serial)(handle.id)]);
  assert.equal(writes, 1); assert.deepEqual(first, second);
  assert.equal(a.get(handle.id)?.state, 'landed');
  assert.ok(names.every((name) => name.includes(handle.id) && name.endsWith(':land')));
  await Promise.all([a.dispose(), b.dispose()]);
 });
 it('keeps a finished result when its destination is gone, and retries after a user selects another', async () => {
  const { a, b } = opsPair(); await Promise.all([a.ready, b.ready]);
  const handle = await a.start(input); await handle.done({ kind: 'opfs-file', path: handle.id, contentType: 'text/plain' }, false);
  const lock: LandLock = (_name, run) => run();
  await createOpLander(a, async () => { throw new Error('Destination is gone'); }, lock)(handle.id);
  assert.equal(a.get(handle.id)?.state, 'done'); assert.equal(a.get(handle.id)?.landingError, 'Destination is gone');
  assert.equal(a.get(handle.id)?.result?.kind, 'opfs-file');
  await createOpLander(a, async () => ({ kind: 'vfs-file', fileId: 'chosen' }), lock)(handle.id);
  assert.equal(a.get(handle.id)?.state, 'landed'); assert.equal(a.get(handle.id)?.landingError, undefined);
  await Promise.all([a.dispose(), b.dispose()]);
 });
});
