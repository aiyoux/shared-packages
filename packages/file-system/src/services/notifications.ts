import type { LiveBus } from '../live/bus.js';
import { createRecordStore, type RecordStore } from './store.js';
import { serviceNames } from './names.js';

export type NotificationRecord = {
 id: string;
 source: { kind: 'op'; opId: string } | { kind: 'agent'; sessionId: string } | { kind: 'app'; app: string };
 level: 'info' | 'success' | 'warning' | 'error';
 title: string; body?: string;
 action?: { kind: 'open-op' | 'open-file' | 'open-session'; ref: string };
 createdAt: number; read?: number; dismissed?: number;
};
export type NotificationFrame = { kind: 'changed'; id: string };
export function createNotificationsService(store: RecordStore<NotificationRecord>, bus: LiveBus<NotificationFrame>) {
 const rows = new Map<string, NotificationRecord>();
 const listeners = new Set<() => void>();
 const arrivals = new Set<(record: NotificationRecord) => void>();
 let disposed = false;
 let refreshTail: Promise<void> = Promise.resolve();
 const notify = () => { if (!disposed) for (const fn of listeners) fn(); };
 function accept(record: NotificationRecord, isNew: boolean) {
  rows.set(record.id, record); notify();
  if (isNew && !record.dismissed && !record.read) for (const fn of arrivals) fn(record);
 }
 function refresh(initial = false): Promise<void> {
  return refreshTail = refreshTail.catch(() => {}).then(async () => {
   if (disposed) return;
   for (const record of await store.list()) accept(record, !initial && !rows.has(record.id));
  });
 }
 const ready = refresh(true);
 const stop = bus.onMessage(() => { void refresh().catch((error) => console.error('Could not read notifications', error)); });
 async function change(id: string, fn: (current: NotificationRecord) => NotificationRecord) {
  const next = await store.mutate(id, (row) => row ? fn(row) : undefined);
  if (next) { accept(next, false); bus.broadcast({ kind: 'changed', id }); }
 }
 return {
  ready,
  list: () => [...rows.values()].filter((row) => !row.dismissed).sort((a, b) => b.createdAt - a.createdAt),
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  onArrival(fn: (record: NotificationRecord) => void) { arrivals.add(fn); return () => { arrivals.delete(fn); }; },
  async emit(record: NotificationRecord): Promise<void> {
   await ready;
   let inserted = false;
   const next = await store.mutate(record.id, (row) => { inserted = !row; return row ?? record; });
   if (next) { accept(next, inserted && !rows.has(next.id)); bus.broadcast({ kind: 'changed', id: next.id }); }
  },
  read: (id: string) => change(id, (row) => ({ ...row, read: row.read ?? Date.now() })),
  dismiss: (id: string) => change(id, (row) => ({ ...row, dismissed: row.dismissed ?? Date.now() })),
  async readAll() { for (const row of rows.values()) await change(row.id, (current) => ({ ...current, read: current.read ?? Date.now() })); },
  async dismissAll() { for (const row of rows.values()) await change(row.id, (current) => ({ ...current, dismissed: current.dismissed ?? Date.now() })); },
  async dispose() { disposed = true; stop(); bus.destroy(); listeners.clear(); arrivals.clear(); await store.close(); }
 };
}
export type NotificationsService = ReturnType<typeof createNotificationsService>;
/** Unit-testable policy: toasts are a local attention cue; records are global. */
export function shouldToastNotification(visibility: string, focused: boolean): boolean { return visibility === 'visible' && focused; }
export function notificationStore() { return createRecordStore<NotificationRecord>(serviceNames.notificationsDb); }
