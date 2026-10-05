import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorLink, isOpJob, monitorJobNeedsNoLanding, monitorJobRecord, type MonitorLinkFrame } from '../src/services/monitorLink.ts';
import type { LiveBus } from '../src/live/bus.ts';
import type { Election } from '../src/live/election.ts';
import type { MonitorTransport } from '../src/monitor/client.ts';
import type { MonitorWatchStream } from '../src/monitor/watchStream.ts';
import type { WatchStreamStatus } from '../src/monitor/watchStream.ts';
import type { OpFrame, OpRecord } from '../src/services/ops.ts';
import type { MonitorJob } from '../src/monitor/jobs.ts';
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
it('broadcasts real watch status and starts Files watches when the jobs feed fails', async () => {
 const bus = channel(); const elected = elections();
 let onStatus: ((status: WatchStreamStatus) => void) | undefined;
 let watched = 0; let feeds = 0;
 const createWatch: typeof import('../src/monitor/watchStream.ts').createMonitorWatchStream = (opts) => {
  onStatus = opts.onStatus;
  return { watchFolder() { watched++; opts.onStatus?.('subscribed'); return () => {}; }, getStatus: () => 'subscribed', watchedPaths: () => [], stop() {} };
 };
 const transport = { meta: async () => ({ capabilities: { jobs: true } }) } as unknown as MonitorTransport;
 const jobs = { events: async () => { feeds++; if (feeds === 1) throw new Error('job stream disconnected'); return { abort() {} }; }, list: async () => [], abort: async () => {}, landed: async () => {} };
 const a = createMonitorLink({ ctx: 'a', profile, bus: bus('a'), election: elected.forTab('a'), transport, jobs, onJob() {}, createWatch });
 const b = createMonitorLink({ ctx: 'b', profile, bus: bus('b'), election: elected.forTab('b'), transport, jobs, onJob() {} });
 try {
  b.watchFolder('/Users/me', () => {});
  await drain();
  assert.equal(watched, 1);
  assert.equal(b.status().state, 'unreachable');
  assert.equal(b.status().watchStatus, 'subscribed', 'a jobs failure is not a watcher failure');
  onStatus?.('error'); await drain(); assert.equal(b.status().watchStatus, 'error');
  onStatus?.('subscribed'); await drain(); assert.equal(b.status().watchStatus, 'subscribed');
  await new Promise((resolve) => setTimeout(resolve, 550)); await drain();
  assert.equal(feeds, 2); assert.equal(b.status().state, 'reachable');
 } finally { a.dispose(); b.dispose(); }
});
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

it('acknowledges only finished jobs that hold no result, and keeps relays out of ops', () => {
 const job = (feature: 'ai' | 'tools' | 'fs' | 'b2', state: string, kind = 'copy') => ({ id: `${feature}:1`, jobId: '1', feature, kind, state, createdAt: 1 });
 assert.equal(monitorJobNeedsNoLanding(job('fs', 'done')), true);
 assert.equal(monitorJobNeedsNoLanding(job('b2', 'failed')), true);
 assert.equal(monitorJobNeedsNoLanding(job('fs', 'running')), false, 'a running copy is never acknowledged');
 assert.equal(monitorJobNeedsNoLanding(job('ai', 'done', 'transcription')), false, 'ai results wait for landing');
 assert.equal(monitorJobNeedsNoLanding(job('tools', 'done', 'rife')), false, 'tool results wait for landing');
 assert.equal(isOpJob(job('fs', 'running', 'relay')), false);
 assert.equal(isOpJob(job('fs', 'running')), true);
 assert.equal(monitorJobRecord(profile, job('tools', 'done', 'rife')).kind, 'video');
});

it('a relay job ends its face link when the far device has gone', async () => {
	const { relayJobEnded } = await import('../src/services/monitorLink.ts');
	const relay = (state: string, note?: string) => ({ id: 'fs:1', jobId: '1', feature: 'fs' as const, kind: 'relay', state, createdAt: 1, progress: note ? { done: 0, note } : undefined });
	assert.equal(relayJobEnded(relay('running', 'near parked · far connected')), false);
	assert.equal(relayJobEnded(relay('running', 'near gone · far gone')), true);
	assert.equal(relayJobEnded(relay('aborted')), true);
	assert.equal(relayJobEnded({ ...relay('done'), kind: 'copy' }), false);
});

it('ten tabs share one terminal profile stream, only when the daemon has the feature, and a failure is not an outage', async () => {
 const bus = channel(); const elected = elections();
 let features = ['terminal']; let opens = 0; let fail = true;
 const emitters: ((rev: number) => void)[] = []; const closers: (() => void)[] = [];
 const transport = { meta: async () => ({ capabilities: { jobs: false }, features }) } as unknown as MonitorTransport;
 const jobs = { events: async () => ({ abort() {} }), list: async () => [], abort: async () => {}, landed: async () => {} };
 const openTerminalProfileEvents = async (onRev: (rev: number) => void) => {
  opens++;
  if (fail) { fail = false; throw new Error('404'); }
  let close!: () => void; const closed = new Promise<unknown>((resolve) => { close = () => resolve(undefined); });
  emitters.push(onRev); closers.push(close);
  return { abort() {}, closed };
 };
 const ids = Array.from({ length: 10 }, (_, i) => (i === 0 ? 'a' : `tab-${i}`));
 const links = ids.map((ctx) => createMonitorLink({ ctx, profile, bus: bus(ctx), election: elected.forTab(ctx), transport, jobs, onJob() {}, openTerminalProfileEvents }));
 try {
  await drain();
  assert.equal(opens, 0, 'nobody asked yet');
  const seen = links.map(() => [] as number[]);
  const stops = links.map((link, i) => link.subscribeTerminalProfile((rev) => seen[i].push(rev)));
  await drain();
  assert.equal(opens, 1);
  assert.equal(links[5].status().state, 'reachable', 'a missing profile stream does not mark the monitor unreachable');
  await new Promise((resolve) => setTimeout(resolve, 1050)); await drain();
  assert.equal(opens, 2, 'retried quietly');
  emitters.at(-1)!(7); await drain();
  for (const revs of seen) assert.deepEqual(revs, [7]);
  // A late subscriber gets the last rev straight away.
  let late: number | undefined; const stopLate = links[3].subscribeTerminalProfile((rev) => { late = rev; });
  assert.equal(late, 7); stopLate();
  // The daemon closing the stream reopens it.
  closers.at(-1)!(); await new Promise((resolve) => setTimeout(resolve, 1050)); await drain();
  assert.equal(opens, 3);
  for (const stop of stops) stop();
  await drain();
 } finally { for (const link of links) link.dispose(); }

 // A daemon without the feature never gets the request.
 features = []; opens = 0; fail = false;
 const bus2 = channel(); const elected2 = elections();
 const solo = createMonitorLink({ ctx: 'a', profile, bus: bus2('a'), election: elected2.forTab('a'), transport, jobs, onJob() {}, openTerminalProfileEvents });
 try { solo.subscribeTerminalProfile(() => {}); await drain(); assert.equal(opens, 0); } finally { solo.dispose(); }
});

it('reconciles only successful current-leader snapshots and respects removals during a list request', async () => {
 const bus = channel(); const elected = elections();
 const row = { id: 'b2:old', jobId: 'old', feature: 'b2' as const, kind: 'copy', state: 'running', createdAt: 1 };
 const snapshots: string[][] = []; const seen: string[] = [];
 let complete!: (jobs: typeof row[]) => void;
 let receive!: (job: MonitorJob) => void; let remove!: (id: string) => void;
 const jobs = { events: async (onJob: typeof receive, _signal?: AbortSignal, onRemoved?: typeof remove) => { receive = onJob; remove = onRemoved!; return { abort() {} }; }, list: () => new Promise<typeof row[]>((resolve) => { complete = resolve; }), abort: async () => {}, landed: async () => {} };
 const transport = { meta: async () => ({ capabilities: { jobs: true } }) } as unknown as MonitorTransport;
 const link = createMonitorLink({ ctx: 'a', profile, bus: bus('a'), election: elected.forTab('a'), transport, jobs, onJob(job) { seen.push(job.id); }, onJobsListing: async () => {}, onJobsListed: async (ids) => { snapshots.push([...ids]); } });
 try {
  await drain();
  receive(row); remove(row.id);
  receive({ ...row, id: 'ai:new', jobId: 'new', feature: 'ai' });
  complete([row]); await drain();
  assert.deepEqual(snapshots, [['ai:new']]);
  assert.equal(seen.filter((id) => id === row.id).length, 1, 'the stale list does not resurrect a removed job');
  link.retry(); await drain();
  const obsoleteList = complete;
  elected.switchTo('b'); obsoleteList([]); await drain();
  assert.equal(snapshots.length, 1, 'an old leader cannot reconcile its late response');
 } finally { link.dispose(); }
});

it('a failed job list is never treated as an empty snapshot', async () => {
 const bus = channel(); const elected = elections(); let snapshots = 0;
 const transport = { meta: async () => ({ capabilities: { jobs: true } }) } as unknown as MonitorTransport;
 const jobs = { events: async () => ({ abort() {} }), list: async () => { throw new Error('Monitor offline'); }, abort: async () => {}, landed: async () => {} };
 const link = createMonitorLink({ ctx: 'a', profile, bus: bus('a'), election: elected.forTab('a'), transport, jobs, onJob() {}, onJobsListed: async () => { snapshots++; } });
 try { await drain(); assert.equal(snapshots, 0); assert.equal(link.status().state, 'unreachable'); }
 finally { link.dispose(); }
});

it('cancellation confirms missing jobs but reports route, network and permission failures durably', async () => {
 const { IDBFactory } = await import('fake-indexeddb');
 const { createRecordStore } = await import('../src/services/store.ts');
 const { createOpsService } = await import('../src/services/ops.ts');
 const { createMonitorJobsClient } = await import('../src/monitor/jobs.ts');
 const { cancelMonitorOp } = await import('../src/services/monitorLink.ts');
 const bus = { broadcast() {}, broadcastImmediate() {}, onMessage() { return () => {}; }, onSenderGone() { return () => {}; }, destroy() {} } as LiveBus<OpFrame>;
 const ops = createOpsService({ ctx: 'a', store: createRecordStore<OpRecord>('cancel', new IDBFactory()), bus });
 await ops.ready;
 const original = monitorJobRecord(profile, { id: 'b2:old', jobId: 'old', feature: 'b2', kind: 'copy', state: 'running', createdAt: 1 });
 let mode = 'missing';
 const jobs = createMonitorJobsClient(profile.baseUrl, async (url) => {
  if (String(url).endsWith('/v1/jobs')) {
   if (mode === 'offline') throw new Error('Failed to fetch');
   return new Response(JSON.stringify({ jobs: mode === 'route' ? [{ id: 'b2:old', jobId: 'old', feature: 'b2', kind: 'copy', state: 'running', createdAt: 1 }] : [] }));
  }
  return new Response(JSON.stringify({ error: { code: mode === 'denied' ? 'auth.forbidden' : 'jobs.not_found', message: mode === 'denied' ? 'Permission denied' : 'Job not found' } }), { status: mode === 'denied' ? 403 : 404 });
 });
 try {
  for (const current of ['route', 'offline', 'denied', 'missing']) {
   mode = current; await ops.importMonitor(original); await ops.cancel(original.id);
   await cancelMonitorOp(ops, jobs, ops.get(original.id)!);
   const op = ops.get(original.id)!;
   if (mode === 'missing') { assert.equal(op.state, 'stopped'); assert.match(op.error!, /monitor no longer has/); assert.equal(op.cancelError, undefined); }
   else { assert.equal(op.state, 'running'); assert.match(op.cancelError!, /Could not cancel/); assert.match(op.cancelError!, mode === 'offline' ? /Failed to fetch/ : mode === 'denied' ? /Permission denied/ : /404/); }
  }
  await ops.dismissFinished(); assert.equal(ops.list().length, 0);
 } finally { await ops.dispose(); }
});
