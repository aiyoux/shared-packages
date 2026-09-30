import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMonitorJob, createMonitorJobsClient } from '../src/monitor/jobs.ts';
const row = { id: 'ai:a', jobId: 'a', feature: 'ai', kind: 'transcription', state: 'done', createdAt: 1, result: '/v1/ai/jobs/a/result', progress: { done: 20, total: 20 } };
it('parses additive job data and rejects malformed identities and progress', () => {
 assert.equal(parseMonitorJob({ ...row, extra: true })?.result, row.result);
 assert.equal(parseMonitorJob({ ...row, id: 'fs:a' }), null);
 assert.equal(parseMonitorJob({ ...row, createdAt: NaN }), null);
 assert.equal(parseMonitorJob({ ...row, progress: { done: Infinity } })?.progress, undefined);
});
it('uses the unified list, abort and landed endpoints with local network annotations', async () => {
 const requests: Array<{ url: string; init?: RequestInit }> = [];
 const client = createMonitorJobsClient('http://127.0.0.1:8300', async (url, init) => { requests.push({ url: String(url), init }); return new Response(JSON.stringify({ jobs: [row, { broken: true }] })); });
 assert.equal((await client.list()).length, 1);
 await client.abort('ai:a'); await client.landed('ai:a');
 assert.ok(requests[1].url.endsWith('/ai%3Aa/abort'));
 assert.ok(requests[2].url.endsWith('/ai%3Aa/landed'));
 assert.equal((requests[0].init as { targetAddressSpace?: string }).targetAddressSpace, 'loopback');
});
