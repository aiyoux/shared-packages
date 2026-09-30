import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorLink, monitorJobRecord, type MonitorLinkFrame } from '../src/services/monitorLink.ts';
import type { LiveBus } from '../src/live/bus.ts';
import type { Election } from '../src/live/election.ts';
import type { MonitorTransport } from '../src/monitor/client.ts';
import type { MonitorWatchStream } from '../src/monitor/watchStream.ts';
const profile = { v: 1 as const, id: 'p', name: 'Desktop', baseUrl: 'http://127.0.0.1:8300', rootPath: '/', createdAt: 1, updatedAt: 1 };
function channel() {
 const clients = new Map<string, Set<(frame: MonitorLinkFrame, sender: string) => void>>();
 return (ctx: string): LiveBus<MonitorLinkFrame> => {
  const handlers = new Set<(frame: MonitorLinkFrame, sender: string) => void>(); clients.set(ctx, handlers);
  const broadcast = (frame: MonitorLinkFrame) => queueMicrotask(() => { for (const [sender, listeners] of clients) if (sender !== ctx) for (const fn of listeners) fn(structuredClone(frame), ctx); });
  return { broadcast, broadcastImmediate: broadcast, onMessage(fn) { handlers.add(fn); return () => { handlers.delete(fn); }; }, onSenderGone() { return () => {}; }, destroy() { clients.delete(ctx); } };
 };
}
function elections() {
 let ctx = 'a'; let term = 1; const listeners = new Set<() => void>();
 const forTab = (tab: string) => ({
  get isLeader() { return ctx === tab; }, get term() { return ctx === tab ? term : 0; }, get leader() { return { id: ctx, tabId: ctx, term }; },
  onChange(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }, resumeAcquire() {}, takeOver() {}, destroy() {}
 }) as unknown as Election;
 return { forTab, switchTo(tab: string) { ctx = tab; term++; for (const fn of listeners) fn(); } };
}
async function drain() { for (let n = 0; n < 12; n++) await new Promise<void>((resolve) => queueMicrotask(resolve)); }
it('shares folder watches and replays retained subscriptions after leadership changes', async () => {
 const bus = channel(); const elected = elections();
 const watched = new Map<string, Map<string, (events?: unknown[]) => void>>(); let streams = 0;
 const createWatch = (ctx: string) => () => {
  streams++; const paths = new Map<string, (events?: unknown[]) => void>(); watched.set(ctx, paths);
  return { watchFolder(path, fn) { paths.set(path, fn as never); return () => { paths.delete(path); }; }, getStatus: () => 'subscribed', watchedPaths: () => [...paths.keys()], stop: () => paths.clear() } as MonitorWatchStream;
 };
 const transport = { meta: async () => ({ capabilities: { jobs: true } }) } as unknown as MonitorTransport;
 const jobs = { events: async () => ({ abort() {} }), list: async () => [], abort: async () => {}, landed: async () => {} };
 const a = createMonitorLink({ ctx: 'a', profile, bus: bus('a'), election: elected.forTab('a'), transport, jobs, onJob() {}, createWatch: createWatch('a') });
 const b = createMonitorLink({ ctx: 'b', profile, bus: bus('b'), election: elected.forTab('b'), transport, jobs, onJob() {}, createWatch: createWatch('b') });
 let first = 0; let second = 0;
 const stopA = a.watchFolder('/project', () => { first++; }); const stopB = b.watchFolder('/project', () => { second++; });
 await drain(); assert.equal(streams, 1); assert.equal(watched.get('a')?.size, 1);
 watched.get('a')!.get('/project')!([]); await drain(); assert.equal(first, 1); assert.equal(second, 1);
 elected.switchTo('b'); await drain(); assert.equal(streams, 2); assert.equal(watched.get('a')?.size, 0); assert.equal(watched.get('b')?.size, 1);
 watched.get('b')!.get('/project')!([]); await drain(); assert.equal(first, 2); assert.equal(second, 2);
 stopA(); await drain(); assert.equal(watched.get('b')?.size, 1);
 stopB(); await drain(); assert.equal(watched.get('b')?.size, 0);
 a.dispose(); b.dispose();
});
it('projects daemon ownership without calling a monitor outage owner death', () => {
 const op = monitorJobRecord(profile, { id: 'ai:1', jobId: '1', feature: 'ai', kind: 'transcription', state: 'done', createdAt: 1, clientRequestId: 'request', result: '/v1/ai/jobs/1/result' });
 assert.equal(op.id, 'request'); assert.equal(op.owner.kind, 'monitor'); assert.equal(op.state, 'done'); assert.equal(op.kind, 'transcribe'); assert.equal(op.result?.kind, 'monitor-path');
 const failed = monitorJobRecord(profile, { id: 'ai:1', jobId: '1', feature: 'ai', kind: 'transcription', state: 'evicted', createdAt: 1, error: 'Result cap exceeded' });
 assert.equal(failed.state, 'failed'); assert.equal(failed.error, 'Result cap exceeded');
});
it('ten tabs share one job feed, status and retry through its owner', async () => {
 const bus = channel(); const elected = elections(); let probes = 0; let feeds = 0;
 const transport = { meta: async () => { probes++; return { version: 'test-version', capabilities: { jobs: true } }; } } as unknown as MonitorTransport;
 const sample = { id: 'ai:1', jobId: '1', feature: 'ai' as const, kind: 'transcription', state: 'done' as const, createdAt: 1 };
 const jobs = { events: async () => { feeds++; return { abort() {} }; }, list: async () => [sample], abort: async () => {}, landed: async () => {} };
 const seen = Array.from({ length: 10 }, () => new Set<string>());
 const links = seen.map((rows, i) => createMonitorLink({ ctx: i === 0 ? 'a' : `tab-${i}`, profile, bus: bus(i === 0 ? 'a' : `tab-${i}`), election: elected.forTab(i === 0 ? 'a' : `tab-${i}`), transport, jobs, onJob(job) { rows.add(job.id); } }));
 await drain();
 assert.equal(probes, 1); assert.equal(feeds, 1);
 for (const [i, link] of links.entries()) { assert.equal(link.status().version, 'test-version'); assert.equal(link.status().jobs, true); assert.deepEqual([...seen[i]], ['ai:1']); }
 links[9].retry(); await drain();
 assert.equal(probes, 2); assert.equal(feeds, 2);
 for (const link of links) link.dispose();
});
