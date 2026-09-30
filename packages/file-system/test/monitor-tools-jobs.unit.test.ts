import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
	probeToolsFeature,
	resolveToolsMonitor,
	buildToolSubmitUrl,
	submitMonitorToolJob,
	runMonitorToolLegacy,
	readMonitorToolProgressNdjson
} from '../src/monitor/toolsJobs.ts';
import type { MonitorToolProgress } from '../src/monitor/toolsJobs.ts';
import type { MonitorConnectionProfileV1 } from '../src/monitor/types.ts';

// resolveToolsMonitor's reachability sweep and the ops-feed wait
// (waitForMonitorToolJob) are app integration territory (IndexedDB + Web
// Locks live bus); here the transport pieces are exercised with an injected
// fetchImpl.

type FetchMock = Array<{ url: string; init?: RequestInit; res: Response }>;

function ok(json: unknown, status = 200): Response {
	return { ok: status < 400, status, body: null, json: async () => json } as unknown as Response;
}

function ndjsonBody(lines: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const line of lines) controller.enqueue(encoder.encode(line + '\n'));
			controller.close();
		}
	});
}

function fetchFrom(requests: FetchMock) {
	return async (url: unknown, init?: RequestInit): Promise<Response> => {
		const entry = requests.find((row) => row.url === String(url));
		if (!entry) throw new Error(`Unexpected request: ${String(url)}`);
		entry.init = init;
		return entry.res;
	};
}

it('reads capabilities.tools/jobs and treats missing keys as false', async () => {
	const requests: FetchMock = [
		{ url: 'http://127.0.0.1:9847/v1/meta', res: ok({ capabilities: { tools: { rife: true } } }) }
	];
	const caps = await probeToolsFeature('http://127.0.0.1:9847', fetchFrom(requests));
	assert.equal(caps.rife, true);
	assert.equal(caps.srmd, false);
	assert.equal(caps.jobsApi, false);
	assert.equal((requests[0].init as { targetAddressSpace?: string }).targetAddressSpace, 'loopback');
});

it('rejects a non-ok meta with the error envelope detail', async () => {
	const requests: FetchMock = [
		{ url: 'http://127.0.0.1:9847/v1/meta', res: ok({ error: { code: 'tools.invalid_config', message: 'bad' } }, 500) }
	];
	await assert.rejects(
		probeToolsFeature('http://127.0.0.1:9847', fetchFrom(requests)),
		/tools\.invalid_config/
	);
});

it('builds the submit URL with the client request id and tool params', () => {
	assert.equal(
		buildToolSubmitUrl('http://127.0.0.1:9847/', 'rife', { fps: '60' }, 'job-1'),
		'http://127.0.0.1:9847/v1/tools/jobs/rife?fps=60&id=job-1'
	);
	assert.equal(
		buildToolSubmitUrl('http://127.0.0.1:9847', 'srmd', { scale: '2', noise: '3', model: 'models-srmd' }, 'job-2'),
		'http://127.0.0.1:9847/v1/tools/jobs/srmd?scale=2&noise=3&model=models-srmd&id=job-2'
	);
});

it('rejects a 409 submit with the tools.busy envelope detail', async () => {
	const requests: FetchMock = [
		{ url: 'http://127.0.0.1:9847/v1/tools/jobs/srmd?scale=2&id=job-2', res: ok({ error: { code: 'tools.busy', message: 'another job is running' } }, 409) }
	];
	await assert.rejects(
		submitMonitorToolJob(
			{ baseUrl: 'http://127.0.0.1:9847', tool: 'srmd', params: { scale: '2' }, id: 'job-2', body: new Blob(['v']) },
			fetchFrom(requests)
		),
		/tools\.busy/
	);
});

it('runs the legacy fallback: submits, streams ticks, fetches the result', async () => {
	const ticks = [
		'{"jobId":"srv-1","state":"uploading","phase":"upload","percent":0}',
		'{"jobId":"srv-1","state":"running","phase":"interpolate","percent":42}',
		'{"jobId":"srv-1","state":"done","phase":"assemble","percent":100}'
	];
	const requests: FetchMock = [
		{ url: 'http://127.0.0.1:9847/v1/tools/jobs/rife?fps=60&id=job-1', res: ok({ jobId: 'srv-1' }, 202) },
		{ url: 'http://127.0.0.1:9847/v1/tools/jobs/srv-1/progress', res: { ok: true, status: 200, body: ndjsonBody(ticks) } as unknown as Response },
		{
			url: 'http://127.0.0.1:9847/v1/tools/jobs/srv-1/result',
			res: { ok: true, status: 200, blob: async () => new Blob(['mp4-bytes'], { type: 'video/mp4' }) } as unknown as Response
		}
	];
	const seen: number[] = [];
	const states: string[] = [];
	const { blob, jobId } = await runMonitorToolLegacy(
		{ baseUrl: 'http://127.0.0.1:9847', tool: 'rife', params: { fps: '60' }, id: 'job-1', body: new Blob(['video']) },
		(tick: MonitorToolProgress) => {
			if (tick.percent !== undefined) seen.push(tick.percent);
			states.push(tick.state);
		},
		fetchFrom(requests)
	);
	assert.equal(jobId, 'srv-1');
	assert.equal(blob.size, 'mp4-bytes'.length);
	assert.equal(states.join(','), 'uploading,running,done');
	assert.equal(seen.join(','), '0,42,100');
	assert.equal(requests.length, 3);
});

it('throws the failed tick error detail on the legacy path', async () => {
	const requests: FetchMock = [
		{ url: 'http://127.0.0.1:9847/v1/tools/jobs/rife?fps=60&id=job-3', res: ok({ jobId: 'srv-2' }, 202) },
		{
			url: 'http://127.0.0.1:9847/v1/tools/jobs/srv-2/progress',
			res: {
				ok: true,
				status: 200,
				body: ndjsonBody([
					'{"jobId":"srv-2","state":"extracting","phase":"extract","percent":5}',
					'{"jobId":"srv-2","state":"failed","error":"ffmpeg exited 1: bad input"}'
				])
			} as unknown as Response
		}
	];
	await assert.rejects(
		runMonitorToolLegacy(
			{ baseUrl: 'http://127.0.0.1:9847', tool: 'rife', params: { fps: '60' }, id: 'job-3', body: new Blob(['v']) },
			() => {},
			fetchFrom(requests)
		),
		/ffmpeg exited 1: bad input/
	);
});

it('throws when the legacy progress stream closes without a terminal tick', async () => {
	const requests: FetchMock = [
		{ url: 'http://127.0.0.1:9847/v1/tools/jobs/rife?id=job-4', res: ok({ jobId: 'srv-3' }, 202) },
		{
			url: 'http://127.0.0.1:9847/v1/tools/jobs/srv-3/progress',
			res: {
				ok: true,
				status: 200,
				body: ndjsonBody(['{"jobId":"srv-3","state":"running","phase":"interpolate","percent":10}'])
			} as unknown as Response
		}
	];
	await assert.rejects(
		runMonitorToolLegacy(
			{ baseUrl: 'http://127.0.0.1:9847', tool: 'rife', params: {}, id: 'job-4', body: new Blob(['v']) },
			() => {},
			fetchFrom(requests)
		),
		/without a terminal state/
	);
});

it('tolerates a torn NDJSON line before the terminal tick', async () => {
	const seen: MonitorToolProgress[] = [];
	const state = await readMonitorToolProgressNdjson(
		'http://127.0.0.1:9847',
		'srv-4',
		(tick) => seen.push(tick),
		fetchFrom([
			{
				url: 'http://127.0.0.1:9847/v1/tools/jobs/srv-4/progress',
				res: {
					ok: true,
					status: 200,
					body: ndjsonBody([
						'{"jobId":"srv-4","state":"runnin',
						'{"jobId":"srv-4","state":"done","phase":"assemble","percent":100}'
					])
				} as unknown as Response
			}
		])
	);
	assert.equal(state, 'done');
	assert.equal(seen.length, 1);
});

it('prefers the requested profile but falls back to any tools-capable profile', async () => {
	const profiles = [
		{ id: 'b', name: 'No tools', baseUrl: 'http://127.0.0.1:9901' },
		{ id: 'a', name: 'Tools here', baseUrl: 'http://127.0.0.1:9902' }
	] as unknown as MonitorConnectionProfileV1[];
	let listed = 0;
	const probe = await resolveToolsMonitor(
		'b',
		fetchFrom([
			{ url: 'http://127.0.0.1:9902/v1/meta', res: ok({ capabilities: { tools: { srmd: true } } }) }
		]),
		async () => {
			listed += 1;
			return profiles;
		}
	);
	assert.equal(probe.profileId, 'a');
	assert.equal(probe.srmd, true);
	assert.equal(probe.rife, false);
	assert.equal(listed, 1);
});