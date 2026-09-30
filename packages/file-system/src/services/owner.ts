import { contextLockName, serviceContextId } from '../leaseOwner.js';
import { createLiveBus, type LiveBus } from '../live/bus.js';
import { createWaitTracker } from '../live/waits.js';
import { serviceNames } from './names.js';

export type Owner =
 | { kind: 'tab'; ctx: string; label: string }
 | { kind: 'monitor'; profileId: string; name: string; jobId?: string; relayId?: string }
 | { kind: 'device'; peerId: string; label: string };
export type TabStatus = { ctx: string; label: string; hidden: boolean; gone?: boolean };
type TabFrame = { kind: 'hello' } | { kind: 'status'; tab: TabStatus };
export type OwnerLiveness = 'alive' | 'gone' | 'unknown';

/** No lock access means unknown, never permission to declare an owner dead. */
export async function ownerLiveness(owner: Owner): Promise<OwnerLiveness> {
 if (owner.kind !== 'tab' || typeof navigator === 'undefined' || !navigator.locks?.query) return 'unknown';
 const snapshot = await navigator.locks.query();
 return snapshot.held?.some((lock) => lock.name === contextLockName(owner.ctx)) ? 'alive' : 'gone';
}

/** Queue on the existing VFS context lock. Abort disposes a watch, not its owner. */
export async function watchOwner(owner: Owner, signal?: AbortSignal): Promise<void> {
 if (owner.kind !== 'tab' || typeof navigator === 'undefined' || !navigator.locks) {
  throw new Error('This owner requires its transport liveness service');
 }
 await navigator.locks.request(contextLockName(owner.ctx), { signal }, () => {});
}

export function createTabDirectory(ctx: string, bus: LiveBus<TabFrame>) {
 const tabs = new Map<string, TabStatus>();
 const listeners = new Set<() => void>();
 let own: TabStatus = { ctx, label: 'Workspace', hidden: false };
 function changed() { for (const fn of listeners) fn(); }
 function publish() { tabs.set(ctx, own); changed(); bus.broadcast({ kind: 'status', tab: own }); }
 const stop = bus.onMessage((frame) => {
  if (frame.kind === 'hello') { bus.broadcast({ kind: 'status', tab: own }); return; }
  tabs.set(frame.tab.ctx, frame.tab); changed();
 });
 publish();
 bus.broadcast({ kind: 'hello' });
 return {
  labelOf: (id: string, fallback = 'Workspace') => tabs.get(id)?.label ?? fallback,
  status: (id: string) => tabs.get(id),
  update(label: string, hidden: boolean) { own = { ctx, label, hidden }; publish(); },
  markGone(id: string) { const tab = tabs.get(id); if (tab) { tabs.set(id, { ...tab, gone: true }); changed(); } },
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  dispose() { stop(); listeners.clear(); bus.destroy(); }
 };
}
export type TabDirectory = ReturnType<typeof createTabDirectory>;
let directory: TabDirectory | null = null;
let ready: Promise<TabDirectory> | null = null;
export function tabDirectory(): Promise<TabDirectory> {
 return ready ??= serviceContextId().then((ctx) => {
  directory = createTabDirectory(ctx, createLiveBus(serviceNames.tabs, ctx));
  if (typeof document !== 'undefined') {
   const visibility = () => directory?.update(directory.labelOf(ctx), document.hidden);
   document.addEventListener('visibilitychange', visibility);
   visibility();
  }
  return directory;
 });
}
export function currentTabDirectory(): TabDirectory | null { return directory; }
export async function tabOwner(label?: string): Promise<Extract<Owner, { kind: 'tab' }>> {
 const ctx = await serviceContextId();
 const tabs = await tabDirectory();
 return { kind: 'tab', ctx, label: label ?? tabs.labelOf(ctx) };
}

export async function waitForOwner<T>(id: string, owner: Owner, answer: Promise<T>): Promise<T> {
 const tracker = createWaitTracker(id, () => ({ what: 'an answer', detail: `${ownerLabel(owner)} is not answering; that tab may be frozen.` }));
 const end = tracker.begin();
 try { return await answer; } finally { end(); tracker.dispose(); }
}
export function ownerLabel(owner: Owner, ownCtx?: string, tabs = directory): string {
 if (owner.kind === 'monitor') return `Monitor · ${owner.name}`;
 if (owner.kind === 'device') return owner.label;
 const tab = tabs?.status(owner.ctx);
 if (tab?.gone) return 'Stopped: its tab closed';
 const label = tabs?.labelOf(owner.ctx, owner.label) ?? owner.label;
 if (owner.ctx === ownCtx) return tab?.hidden ? 'This tab · In a background tab' : 'This tab';
 return `${tab?.hidden ? 'In a background tab' : 'Another tab'} · ${label}`;
}
export function ownerConsequence(owner: Owner): string {
 return owner.kind === 'monitor' ? 'Keeps running with every tab closed.' : owner.kind === 'tab' ? 'Closing that tab stops it.' : 'Runs on the other device.';
}
