import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJoinedSessions, type JoinedFrame } from '../src/joinedSessions.ts';
import type { LiveBus } from '../src/live/bus.ts';

function network() {
 const clients = new Map<string, Set<(msg: JoinedFrame, sender: string) => void>>();
 const sent: JoinedFrame[] = [];
 const make = (id: string): LiveBus<JoinedFrame> => {
  const handlers = new Set<(msg: JoinedFrame, sender: string) => void>(); clients.set(id, handlers);
  const post = (msg: JoinedFrame) => { sent.push(structuredClone(msg)); queueMicrotask(() => { for (const [other, fns] of clients) if (other !== id) for (const fn of fns) fn(structuredClone(msg), id); }); };
  return { broadcast: post, broadcastImmediate: post, onMessage(fn) { handlers.add(fn); return () => { handlers.delete(fn); }; }, onSenderGone() { return () => {}; }, destroy() { clients.delete(id); } };
 };
 return { make, sent };
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const row = { id: 'join:peer:doc', app: 'text' as const, kind: 'text' as const, title: 'Their text', dirty: false, updatedAt: 1, origin: { peerId: 'peer', device: 'Phone', sessionId: 'doc', write: true } };
describe('volatile joined sessions', () => {
 it('a later tab obtains the joined row and a close clears every tab with its local flag', async () => {
  const n = network(); const closed: boolean[] = [];
  const a = createJoinedSessions({ bus: n.make('a'), changed() {}, closed() {} });
  a.put(row); await settle();
  const b = createJoinedSessions({ bus: n.make('b'), changed() {}, closed(_row, local) { closed.push(local); } });
  await settle(); assert.deepEqual(b.rows(), [row]);
  a.end(row.id); await settle(); assert.deepEqual(b.rows(), []); assert.deepEqual(closed, [false]);
  a.clear(); b.clear();
 });
 it('a delayed replay cannot resurrect an ended epoch, while a fresh join can reopen', async () => {
  const n = network(); const a = createJoinedSessions({ bus: n.make('a'), changed() {}, closed() {} });
  a.put(row); await settle(); const oldPut = n.sent.find((msg) => msg.kind === 'put')!;
  a.end(row.id); await settle(); const stale = n.make('stale'); stale.broadcast(oldPut); await settle();
  assert.deepEqual(a.rows(), []);
  a.put({ ...row, title: 'New share' }); await settle(); stale.broadcast(oldPut); await settle();
  assert.equal(a.rows()[0]?.title, 'New share'); a.clear(); stale.destroy();
 });
 it('destroying every tab loses the foreign session, without writing any persistent board', async () => {
  const n = network(); const a = createJoinedSessions({ bus: n.make('a'), changed() {}, closed() {} });
  a.put(row); await settle(); a.clear();
  const b = createJoinedSessions({ bus: n.make('b'), changed() {}, closed() {} }); await settle();
  assert.deepEqual(b.rows(), []); b.clear();
 });
});
