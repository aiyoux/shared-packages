import { createElection, type Election } from '../live/election.js';
import { createLiveBus, type LiveBus } from '../live/bus.js';
import { serviceContextId } from '../leaseOwner.js';
import { createMonitorClient, type MonitorCapabilities, type MonitorHostSnapshot, type MonitorTransport } from '../monitor/client.js';
import { createMonitorWatchStream, type MonitorWatchFsEvent, type MonitorWatchStream, type WatchFolderListener } from '../monitor/watchStream.js';
import { createMonitorJobsClient, type MonitorJob } from '../monitor/jobs.js';
import { openJsonSse } from '../monitor/sse.js';
import type { WatchStreamStatus } from '../monitor/watchStream.js';
import type { MonitorConnectionProfileV1 } from '../monitor/types.js';
import { opsService, type OpKindId, type OpsService, type OpRecord } from './ops.js';
import { connectionsService } from './connections.js';
import { serviceNames } from './names.js';

export type MonitorLinkStatus = { state: 'connecting' | 'reachable' | 'unreachable'; reason?: string; jobs: boolean; watchStatus?: WatchStreamStatus; ownerCtx?: string; version?: string; capabilities?: MonitorCapabilities; features?: string[] };
export type MonitorLinkFrame =
 | { kind: 'hello' }
 | { kind: 'retry' }
 | { kind: 'subscriptions'; paths: string[]; host: boolean; terminalProfile?: boolean }
 | { kind: 'status'; term: number; status: MonitorLinkStatus }
 | { kind: 'folder'; term: number; path: string; events?: MonitorWatchFsEvent[] }
 | { kind: 'host'; term: number; snapshot: MonitorHostSnapshot }
 | { kind: 'job'; term: number; job: MonitorJob }
 | { kind: 'terminalProfile'; term: number; rev: number };

/** One elected tab owns the profile's streams; subscriptions remain in callers. */
export function createMonitorLink(options: {
 ctx: string; profile: MonitorConnectionProfileV1; bus: LiveBus<MonitorLinkFrame>;
 election: Election; transport: MonitorTransport; jobs: ReturnType<typeof createMonitorJobsClient>;
 onJob: (job: MonitorJob) => void; createWatch?: typeof createMonitorWatchStream;
 /** Leader only: a job the daemon no longer lists (landed, reaped). */
 onJobRemoved?: (id: string) => void;
 /** Leader only: the terminal feature's profile rev stream (tests inject it). */
 openTerminalProfileEvents?: (onRev: (rev: number) => void) => Promise<{ abort: () => void; closed: Promise<unknown> }>;
}) {
 const { bus, election, transport } = options;
 const folders = new Map<string, Set<WatchFolderListener>>();
 const hostListeners = new Set<(snapshot: MonitorHostSnapshot) => void>();
 const terminalProfileListeners = new Set<(rev: number) => void>();
 const remote = new Map<string, { paths: string[]; host: boolean; terminalProfile?: boolean }>();
 const subscriptions = new Map<string, () => void>();
 const changes = new Set<() => void>();
 const knownJobs = new Map<string, MonitorJob>();
 let lastHost: MonitorHostSnapshot | undefined;
 let lastTerminalRev: number | undefined;
 let terminalProfile: { abort: () => void } | undefined;
 let terminalProfileStarting = false;
 let terminalProfileRetry: ReturnType<typeof setTimeout> | undefined;
 let terminalProfileAttempts = 0;
 let status: MonitorLinkStatus = { state: 'connecting', jobs: false };
 let watch: MonitorWatchStream | undefined;
 let host: { abort: () => void } | undefined;
 let controller: AbortController | undefined;
 let activeTerm = 0;
 let hostStarting = false;
 let disposed = false;
 let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
 let reconnectAttempts = 0;
 const own = () => ({ paths: [...folders.keys()], host: hostListeners.size > 0, terminalProfile: terminalProfileListeners.size > 0 });
 const notify = () => { for (const fn of changes) fn(); };
 function sendOwn() { remote.set(options.ctx, own()); bus.broadcast({ kind: 'subscriptions', ...own() }); reconcile(); }
 function publish(frame: MonitorLinkFrame) { bus.broadcast(frame); }
 function setStatus(next: MonitorLinkStatus) { status = next; notify(); if (election.isLeader) publish({ kind: 'status', term: election.term, status }); }
 function folderEvent(path: string, events?: MonitorWatchFsEvent[]) { for (const fn of folders.get(path) ?? []) fn(events); }
 function hostEvent(snapshot: MonitorHostSnapshot) { lastHost = snapshot; for (const fn of hostListeners) fn(snapshot); }
 function terminalProfileEvent(rev: number) { lastTerminalRev = rev; for (const fn of terminalProfileListeners) fn(rev); }
 function stopTerminalProfile() { if (terminalProfileRetry) clearTimeout(terminalProfileRetry); terminalProfileRetry = undefined; terminalProfile?.abort(); terminalProfile = undefined; terminalProfileStarting = false; }
 function stopStreams() {
  if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = undefined;
  controller?.abort(); controller = undefined;
  watch?.stop(); watch = undefined;
  for (const stop of subscriptions.values()) stop(); subscriptions.clear();
  host?.abort(); host = undefined; hostStarting = false; activeTerm = 0;
  stopTerminalProfile(); terminalProfileAttempts = 0;
 }
 function streamFailed(error: unknown, ctl: AbortController) {
  if (ctl.signal.aborted || controller !== ctl) return;
  setStatus({ ...status, state: 'unreachable', reason: String(error) });
  if (disposed || reconnectTimer || reconnectAttempts >= 12) return;
  const delay = Math.min(500 * 2 ** reconnectAttempts++, 30_000);
  reconnectTimer = setTimeout(() => { reconnectTimer = undefined; if (controller === ctl && election.isLeader) { stopStreams(); leadership(); } }, delay);
 }
 function reconcile() {
  if (!election.isLeader || !controller || controller.signal.aborted) return;
  const term = activeTerm; const ctl = controller;
  const paths = new Set([...remote.values()].flatMap((row) => row.paths));
  if (paths.size && !watch) watch = (options.createWatch ?? createMonitorWatchStream)({ transport, onStatus(watchStatus) { if (!ctl.signal.aborted && election.isLeader && election.term === term) setStatus({ ...status, watchStatus }); } });
  for (const [path, stop] of subscriptions) if (!paths.has(path)) { stop(); subscriptions.delete(path); }
  for (const path of paths) if (!subscriptions.has(path) && watch) {
   subscriptions.set(path, watch.watchFolder(path, (events) => { if (ctl.signal.aborted || !election.isLeader || election.term !== term) return; folderEvent(path, events); publish({ kind: 'folder', term, path, events }); }));
  }
  const wantHost = [...remote.values()].some((row) => row.host);
  if (!wantHost) { host?.abort(); host = undefined; }
  else if (!host && !hostStarting) {
   hostStarting = true;
   void transport.openHostEvents({ onSnapshot(snapshot) { if (ctl.signal.aborted || election.term !== term) return; hostEvent(snapshot); publish({ kind: 'host', term, snapshot }); } }).then((stream) => {
    if (ctl.signal.aborted || election.term !== term || ![...remote.values()].some((row) => row.host)) stream.abort(); else host = stream;
   }).catch((error) => streamFailed(error, ctl)).finally(() => { if (controller === ctl) hostStarting = false; });
  }
  // The profile stream is optional: an older daemon has no terminal feature,
  // and a failure here retries quietly instead of calling the monitor down.
  const wantTerminal = [...remote.values()].some((row) => row.terminalProfile) && status.features?.includes('terminal') === true;
  if (!wantTerminal) stopTerminalProfile();
  else if (!terminalProfile && !terminalProfileStarting && !terminalProfileRetry) {
   terminalProfileStarting = true;
   const onRev = (rev: number) => { if (ctl.signal.aborted || election.term !== term) return; terminalProfileAttempts = 0; terminalProfileEvent(rev); publish({ kind: 'terminalProfile', term, rev }); };
   const retry = () => {
    if (ctl.signal.aborted || controller !== ctl || terminalProfileRetry) return;
    terminalProfile = undefined; terminalProfileStarting = false;
    const delay = Math.min(1000 * 2 ** terminalProfileAttempts++, 30_000);
    terminalProfileRetry = setTimeout(() => { terminalProfileRetry = undefined; reconcile(); }, delay);
   };
   void openTerminalProfile(onRev).then((stream) => {
    if (ctl.signal.aborted || election.term !== term) { stream.abort(); return; }
    terminalProfile = stream; terminalProfileStarting = false;
    void stream.closed.then(() => { if (terminalProfile === stream) retry(); });
   }).catch(() => { if (controller === ctl) retry(); });
  }
 }
 function openTerminalProfile(onRev: (rev: number) => void) {
  if (options.openTerminalProfileEvents) return options.openTerminalProfileEvents(onRev);
  let closed!: (reason: unknown) => void;
  const done = new Promise<unknown>((resolve) => { closed = resolve; });
  return openJsonSse({ url: `${options.profile.baseUrl.replace(/\/+$/, '')}/v1/terminal/profile/events`, onEvent(event, data) { const rev = (data as { rev?: unknown })?.rev; if (event === 'terminal.profile' && typeof rev === 'number') onRev(rev); }, onClose: closed })
   .then((stream) => ({ abort: stream.abort, closed: done }));
 }
 function leadership() {
  if (disposed) return;
  if (!election.isLeader) { if (controller) stopStreams(); sendOwn(); return; }
  if (activeTerm === election.term && controller) return;
  stopStreams(); activeTerm = election.term; const term = activeTerm;
  const ctl = controller = new AbortController();
  remote.clear(); remote.set(options.ctx, own());
  bus.broadcast({ kind: 'hello' });
  setStatus({ state: 'connecting', jobs: false, ownerCtx: options.ctx });
  void (async () => {
   try {
    const meta = await transport.meta();
    if (ctl.signal.aborted) return;
    const supported = meta.capabilities?.jobs === true;
    setStatus({ state: 'reachable', jobs: supported, watchStatus: status.watchStatus, ownerCtx: options.ctx, version: meta.version, capabilities: meta.capabilities, features: meta.features });
    // Files watches remain independent of the jobs feed.
    reconcile();
    if (supported) {
     const receive = (job: MonitorJob) => { if (ctl.signal.aborted || election.term !== term) return; const previous = knownJobs.get(job.id); if (previous && ['done', 'failed', 'aborted', 'evicted'].includes(previous.state) && !['done', 'failed', 'aborted', 'evicted'].includes(job.state)) return; knownJobs.set(job.id, job); options.onJob(job); publish({ kind: 'job', term, job }); };
     // Subscribe before list, so a job cannot finish in a list-to-stream gap.
     await options.jobs.events(receive, ctl.signal, (id) => { knownJobs.delete(id); options.onJobRemoved?.(id); }, (error) => streamFailed(error, ctl));
     for (const job of await options.jobs.list(ctl.signal)) receive(job);
    }
    reconcile();
   } catch (error) { streamFailed(error, ctl); }
  })();
 }
 const stopBus = bus.onMessage((frame, sender) => {
  if (frame.kind === 'hello') {
   sendOwn();
   if (election.isLeader) { publish({ kind: 'status', term: election.term, status }); for (const job of knownJobs.values()) publish({ kind: 'job', term: election.term, job }); if (lastHost) publish({ kind: 'host', term: election.term, snapshot: lastHost }); if (lastTerminalRev !== undefined) publish({ kind: 'terminalProfile', term: election.term, rev: lastTerminalRev }); }
  } else if (frame.kind === 'retry') { reconnectAttempts = 0; if (election.isLeader) { stopStreams(); leadership(); } }
  else if (frame.kind === 'subscriptions') { remote.set(sender, frame); reconcile(); }
  else if (election.leader?.term === frame.term && election.leader.tabId === sender) {
   if (frame.kind === 'status') { status = frame.status; notify(); }
   else if (frame.kind === 'folder') folderEvent(frame.path, frame.events);
   else if (frame.kind === 'host') hostEvent(frame.snapshot);
   else if (frame.kind === 'terminalProfile') terminalProfileEvent(frame.rev);
   else { knownJobs.set(frame.job.id, frame.job); options.onJob(frame.job); }
  }
 });
 const stopGone = bus.onSenderGone((ctx) => { remote.delete(ctx); reconcile(); });
 const stopElection = election.onChange(leadership);
 bus.broadcast({ kind: 'hello' }); leadership();
 return {
  status: () => status,
  subscribe(fn: () => void) { changes.add(fn); return () => { changes.delete(fn); }; },
  watchFolder(path: string, listener: WatchFolderListener) { let rows = folders.get(path); if (!rows) folders.set(path, rows = new Set()); rows.add(listener); sendOwn(); return () => { rows!.delete(listener); if (!rows!.size) folders.delete(path); sendOwn(); }; },
  subscribeHost(listener: (snapshot: MonitorHostSnapshot) => void) { hostListeners.add(listener); if (lastHost) listener(lastHost); sendOwn(); return () => { hostListeners.delete(listener); sendOwn(); }; },
  /** The terminal app's shared profile changed on the daemon (`rev` only; re-read it). Needs the `terminal` feature. */
  subscribeTerminalProfile(listener: (rev: number) => void) { terminalProfileListeners.add(listener); if (lastTerminalRev !== undefined) listener(lastTerminalRev); sendOwn(); return () => { terminalProfileListeners.delete(listener); sendOwn(); }; },
  retry() { reconnectAttempts = 0; if (election.isLeader) { stopStreams(); leadership(); } else { bus.broadcast({ kind: 'retry' }); election.resumeAcquire(); } },
  takeOwnership() { election.takeOver(); },
  dispose() { disposed = true; stopStreams(); stopElection(); stopBus(); stopGone(); changes.clear(); bus.destroy(); election.destroy(); }
 };
}
export type MonitorLink = ReturnType<typeof createMonitorLink>;
const links = new Map<string, Promise<MonitorLink>>();
const jobKinds: Record<string, OpKindId> = { transcription: 'transcribe', 'text-to-speech': 'speak', 'image-generation': 'generate', chat: 'chat', copy: 'copy', rife: 'video', srmd: 'video', audio: 'audio-tool' };
const TERMINAL_JOB_STATES = ['done', 'failed', 'aborted', 'evicted'];
/** Relay jobs carry a device link, not an operation: they belong to the connection registry (W9/W10). */
export const isOpJob = (job: MonitorJob) => job.kind !== 'relay';
/** A relay whose far device has gone is over, whatever its job still says (note: `near … · far …`). */
export const relayJobEnded = (job: MonitorJob) => job.kind === 'relay' && (TERMINAL_JOB_STATES.includes(job.state) || /\bfar gone\b/.test(job.progress?.note ?? ''));
/**
 * fs and b2 jobs hold no result bytes (the result is already on disk or in the
 * bucket), so once the op record is durable the daemon's row has nothing left
 * to collect. ai and tools results wait for landing or an explicit dismissal.
 */
export const monitorJobNeedsNoLanding = (job: MonitorJob) => TERMINAL_JOB_STATES.includes(job.state) && (job.feature === 'fs' || job.feature === 'b2');
export function monitorJobRecord(profile: MonitorConnectionProfileV1, job: MonitorJob): OpRecord {
 const state = job.state === 'done' ? 'done' : job.state === 'aborted' ? 'cancelled' : job.state === 'failed' || job.state === 'evicted' ? 'failed' : 'running';
 const kind = jobKinds[job.kind] ?? 'copy';
 return { id: job.clientRequestId ?? `monitor:${profile.id}:${job.id}`, kind, app: ['transcribe', 'speak', 'generate', 'chat'].includes(kind) ? kind : 'files', title: `${job.kind} · ${profile.name}`, owner: { kind: 'monitor', profileId: profile.id, name: profile.name, jobId: job.id }, where: { executor: 'monitor', note: profile.name }, state, resumable: false, createdAt: job.createdAt, endedAt: job.finishedAt, error: job.error, result: job.result ? { kind: 'monitor-path', profileId: profile.id, path: job.result } : undefined };
}
export function getMonitorLink(profile: MonitorConnectionProfileV1, transport?: MonitorTransport): Promise<MonitorLink> {
 const existing = links.get(profile.id); if (existing) return existing;
 const next = (async () => {
  const ctx = await serviceContextId(); const ops: OpsService = await opsService();
  const jobs = createMonitorJobsClient(profile.baseUrl);
  const election = createElection(serviceNames.monitorLock(profile.id), { tabId: ctx });
  const acknowledged = new Set<string>();
  const endRelay = (jobId: string) => void connectionsService().then((links) => links.endRelay(profile.id, jobId)).catch((error) => console.error('Could not end a relayed connection', error));
  const link = createMonitorLink({ ctx, profile, election, bus: createLiveBus(serviceNames.monitorBus(profile.id), ctx), transport: transport ?? createMonitorClient({ baseUrl: profile.baseUrl }), jobs,
  onJobRemoved(id) { if (id.startsWith('fs:')) endRelay(id.slice(3)); },
  onJob(job) {
   if (!isOpJob(job)) { if (election.isLeader && relayJobEnded(job)) endRelay(job.jobId); return; }
   const record = monitorJobRecord(profile, job);
   const original = job.clientRequestId ? ops.get(job.clientRequestId) : undefined;
   if (!original || original.kind !== record.kind || original.owner.kind === 'device' || original.owner.kind === 'monitor' && (original.owner.profileId !== profile.id || original.owner.jobId !== job.id)) record.id = `monitor:${profile.id}:${job.id}`;
   // Every tab receives the same job frame, so progress stays local to each.
   void ops.importMonitor(record).then(async () => {
    if (job.progress) ops.reportProgress(record.id, job.progress, { broadcast: false });
    if (!election.isLeader || !monitorJobNeedsNoLanding(job) || acknowledged.has(job.id)) return;
    acknowledged.add(job.id);
    await jobs.landed(job.id);
    await ops.change(record.id, (current) => ({ ...current, monitorAcknowledged: true }));
   }).catch((error) => { acknowledged.delete(job.id); console.error('Could not reconcile monitor job', error); });
  } });
  const stopCancel = ops.onCancelRequest((op) => { if (election.isLeader && op.owner.kind === 'monitor' && op.owner.profileId === profile.id && op.owner.jobId) void jobs.abort(op.owner.jobId).catch((error) => console.error('Could not cancel monitor job', error)); });
  const dispose = link.dispose; link.dispose = () => { stopCancel(); dispose(); links.delete(profile.id); };
  return link;
 })().catch((error) => { links.delete(profile.id); throw error; });
 links.set(profile.id, next); return next;
}
