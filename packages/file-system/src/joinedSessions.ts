/** Volatile joined rows, replicated across live tabs; foreign documents never enter storage. */
import type { OpenSession } from './openSessions.js';
import type { LiveBus } from './live/bus.js';

type Entry = { row: OpenSession; epoch: string; revision: number };
export type JoinedFrame =
 | { kind: 'hello' }
 | { kind: 'rows'; entries: Entry[]; ended: string[] }
 | { kind: 'put'; entry: Entry }
 | { kind: 'end'; id: string; epoch: string };

export function createJoinedSessions(opts: {
 bus?: LiveBus<JoinedFrame>;
 changed: () => void;
 closed: (row: OpenSession, local: boolean) => void;
}) {
 const entries = new Map<string, Entry>();
 const ended = new Set<string>();
 let bus = opts.bus;
 let stop: (() => void) | undefined;
 function receive(entry: Entry) {
  if (!entry.row.origin || ended.has(entry.epoch)) return;
  const before = entries.get(entry.row.id);
  if (before && before.epoch === entry.epoch && before.revision >= entry.revision) return;
  entries.set(entry.row.id, entry);
  opts.changed();
 }
 function end(id: string, epoch: string, local: boolean) {
  ended.add(epoch);
  const current = entries.get(id);
  if (!current || current.epoch !== epoch) return;
  entries.delete(id);
  opts.closed(current.row, local);
  opts.changed();
 }
 function attach(next: LiveBus<JoinedFrame>) {
  stop?.();
  bus = next;
  stop = next.onMessage((frame) => {
   if (frame.kind === 'hello') next.broadcast({ kind: 'rows', entries: [...entries.values()], ended: [...ended] });
   else if (frame.kind === 'put') receive(frame.entry);
   else if (frame.kind === 'end') end(frame.id, frame.epoch, false);
   else if (frame.kind === 'rows') {
    for (const epoch of frame.ended) ended.add(epoch);
    for (const [id, entry] of entries) if (ended.has(entry.epoch)) end(id, entry.epoch, false);
    for (const entry of frame.entries) receive(entry);
   }
  });
  next.broadcast({ kind: 'hello' });
  // Local joins may have happened while the context's live lock was starting.
  if (entries.size) next.broadcast({ kind: 'rows', entries: [...entries.values()], ended: [...ended] });
 }
 if (bus) attach(bus);
 return {
  rows: () => [...entries.values()].map((entry) => entry.row),
  get: (id: string) => entries.get(id)?.row,
  has: (id: string) => entries.has(id),
  put(row: OpenSession) {
   const before = entries.get(row.id);
   const entry = { row, epoch: before?.epoch ?? crypto.randomUUID(), revision: (before?.revision ?? 0) + 1 };
   entries.set(row.id, entry);
   bus?.broadcast({ kind: 'put', entry });
   opts.changed();
  },
  end(id: string) {
   const entry = entries.get(id);
   if (!entry) return undefined;
   end(id, entry.epoch, true);
   bus?.broadcast({ kind: 'end', id, epoch: entry.epoch });
   return entry.row;
  },
  attach,
  clear() { stop?.(); bus?.destroy(); entries.clear(); ended.clear(); }
 };
}
