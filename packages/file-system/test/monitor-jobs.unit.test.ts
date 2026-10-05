import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMonitorJob, createMonitorJobsClient, MonitorJobsRequestError } from '../src/monitor/jobs.ts';
const row = { id: 'ai:a', jobId: 'a', feature: 'ai', kind: 'transcription', state: 'done', createdAt: 1, result: '/v1/ai/jobs/a/result', progress: { done: 20, total: 20 } };
it('parses additive job data and rejects malformed identities and progress', () => {
 assert.equal(parseMonitorJob({ ...row, extra: true })?.result, row.result);
 assert.equal(parseMonitorJob({ ...row, id: 'fs:a' }), null);
 assert.equal(parseMonitorJob({ ...row, createdAt: NaN }), null);
 assert.equal(parseMonitorJob({ ...row, progress: { done: Infinity } })?.progress, undefined);
});
it('preserves HTTP status and daemon reason, and only acknowledges a job-specific 404', async () => {
 const client = createMonitorJobsClient('http://localhost:8300', async () => new Response(JSON.stringify({ error: { code: 'jobs.not_found', message: 'Job not found' } }), { status: 404 }));
 await assert.rejects(client.abort('b2:old'), (error: unknown) => error instanceof MonitorJobsRequestError && error.status === 404 && error.code === 'jobs.not_found' && error.message.includes('Job not found'));
 await client.landed('b2:old');
 const missingRoute = createMonitorJobsClient('http://localhost:8300', async () => new Response('Not Found', { status: 404 }));
 await assert.rejects(missingRoute.landed('ai:1'), (error: unknown) => error instanceof MonitorJobsRequestError && error.status === 404);
 const refused = createMonitorJobsClient('http://localhost:8300', async () => new Response(JSON.stringify({ error: { code: 'jobs.not_finished', message: 'Job is still running' } }), { status: 409 }));
 await assert.rejects(refused.landed('tools:1'), /Job is still running/);
});
it('uses the unified list, abort and landed endpoints with local network annotations', async () => {
 const requests: Array<{ url: string; init?: RequestInit }> = [];
 const client = createMonitorJobsClient('http://127.0.0.1:8300', async (url, init) => { requests.push({ url: String(url), init }); return new Response(JSON.stringify({ jobs: [row] })); });
 assert.equal((await client.list()).length, 1);
 await client.abort('ai:a'); await client.landed('ai:a');
 assert.ok(requests[1].url.endsWith('/ai%3Aa/abort'));
 assert.ok(requests[2].url.endsWith('/ai%3Aa/landed'));
 assert.equal((requests[0].init as { targetAddressSpace?: string }).targetAddressSpace, 'loopback');
});
it('rejects malformed snapshots instead of treating unparsed jobs as missing', async () => {
 const client = createMonitorJobsClient('http://localhost:8300', async () => new Response(JSON.stringify({ jobs: [row, { broken: true }] })));
 await assert.rejects(client.list(), /job status could not be confirmed/);
});
