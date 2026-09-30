import { withLocalAddressSpace } from './localNetwork.js';
import { openJsonSse } from './sse.js';

export type MonitorJob = { id: string; jobId: string; feature: 'ai' | 'tools' | 'fs' | 'b2'; kind: string; state: string; createdAt: number; finishedAt?: number; clientRequestId?: string; progress?: { done: number; total?: number; note?: string }; result?: string; error?: string };
export function parseMonitorJob(raw: unknown): MonitorJob | null {
 if (!raw || typeof raw !== 'object') return null;
 const row = raw as Record<string, unknown>;
 if (typeof row.id !== 'string' || typeof row.jobId !== 'string' || !['ai', 'tools', 'fs', 'b2'].includes(String(row.feature)) || typeof row.kind !== 'string' || typeof row.state !== 'string' || typeof row.createdAt !== 'number' || !Number.isFinite(row.createdAt)) return null;
 const job: MonitorJob = { id: row.id, jobId: row.jobId, feature: row.feature as MonitorJob['feature'], kind: row.kind, state: row.state, createdAt: row.createdAt };
 if (!job.id.startsWith(`${job.feature}:`)) return null;
 for (const key of ['result', 'error', 'clientRequestId'] as const) if (typeof row[key] === 'string') job[key] = row[key];
 if (typeof row.finishedAt === 'number' && Number.isFinite(row.finishedAt)) job.finishedAt = row.finishedAt;
 const progress = row.progress as Record<string, unknown> | undefined;
 if (progress && typeof progress.done === 'number' && Number.isFinite(progress.done) && progress.done >= 0) {
  job.progress = { done: progress.done };
  if (typeof progress.total === 'number' && Number.isFinite(progress.total) && progress.total >= 0) job.progress.total = progress.total;
  if (typeof progress.note === 'string') job.progress.note = progress.note;
 }
 return job;
}
export function createMonitorJobsClient(baseUrl: string, fetchImpl: typeof fetch = fetch) {
 const url = (path: string) => `${baseUrl.replace(/\/$/, '')}${path}`;
 async function request(path: string, init?: RequestInit) {
  const endpoint = url(path);
  const response = await fetchImpl(endpoint, withLocalAddressSpace(endpoint, init));
  if (!response.ok) throw new Error(`Monitor jobs request failed (${response.status})`);
  return response;
 }
 return {
  async list(signal?: AbortSignal): Promise<MonitorJob[]> {
   const data = await (await request('/v1/jobs', { signal })).json();
   if (!Array.isArray(data.jobs)) throw new Error('Monitor returned no jobs list');
   return data.jobs.flatMap((raw: unknown) => { const job = parseMonitorJob(raw); return job ? [job] : []; });
  },
  events(onJob: (job: MonitorJob) => void, signal?: AbortSignal, onRemoved?: (id: string) => void, onClose?: (error: unknown) => void) {
   return openJsonSse({ url: url('/v1/jobs/events'), fetchImpl, signal, onClose, onEvent(event, data) {
    if (event === 'removed') { if (data && typeof data === 'object' && typeof (data as { id?: unknown }).id === 'string') onRemoved?.((data as { id: string }).id); return; }
    const job = parseMonitorJob(data); if (job) onJob(job);
   } });
  },
  async abort(id: string) { await request(`/v1/jobs/${encodeURIComponent(id)}/abort`, { method: 'POST' }); },
  async landed(id: string) { await request(`/v1/jobs/${encodeURIComponent(id)}/landed`, { method: 'POST' }); }
 };
}
