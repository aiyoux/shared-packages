import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
	probeToolsFeature,
	resolveSelectedToolsMonitor,
	buildToolSubmitUrl,
	submitMonitorToolJob,
	runMonitorToolLegacy,
	readMonitorToolProgressNdjson
} from '../src/monitor/toolsJobs.ts';
import type { AiSelectionMap } from '../src/ai/selection.ts';
import type { MonitorToolProgress } from '../src/monitor/toolsJobs.ts';
import type { MonitorConnectionProfileV1 } from '../src/monitor/types.ts';

// resolveSelectedToolsMonitor's cross-tab selection store is exercised here
// only through injected impls (IndexedDB + Web Locks live bus are app
// integration territory); the transport pieces run with an injected fetchImpl.

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

/** The empty selection map (no picks at all). */
const EMPTY: AiSelectionMap = { v: 3, tasks: {} };

function mapOf(task: string, ref: unknown): AiSelectionMap {
	return { v: 3, tasks: { [task]: { default: ref as never } } } as AiSelectionMap;
}

/** resolveSelectedToolsMonitor deps minus the fetch mock, which `fetches` supplies. */
function depsFor(
	profiles: unknown[],
	map: AiSelectionMap,
	activeId: string | null = null,
	fetches: FetchMock = []
) {
	return {
		fetchImpl: fetchFrom(fetches),
		listProfilesImpl: async () => profiles as MonitorConnectionProfileV1[],
		getSelectionMapImpl: async () => map,
		getActiveProfileIdImpl: async () => activeId
	};
}

it('reads capabilities.tools/jobs and treats missing keys as false', async () => {
	const requests: FetchMock = [
		{ url: 'http://127.0.0.1:9847/v1/meta', res: ok({ capabilities: { tools: { rife: true } } }) }
	];
	const caps = await probeToolsFeature('http://127.0.0.1:9847', fetchFrom(requests));
	assert.equal(caps.rife, true);
	assert.equal(caps.srmd, false);
	assert.equal(caps.audio, false);
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
	assert.equal(
		buildToolSubmitUrl('http://127.0.0.1:9847', 'audio', { engine: 'novasr', denoise: '1' }, 'job-3'),
		'http://127.0.0.1:9847/v1/tools/jobs/audio?engine=novasr&denoise=1&id=job-3'
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

it('resolves the selection through the pick’s pinned profile, requiring its engine', async () => {
	const profiles = [
		{ id: 'b', name: 'No tools', baseUrl: 'http://127.0.0.1:9901' },
		{ id: 'a', name: 'Tools here', baseUrl: 'http://127.0.0.1:9902' }
	] as unknown as MonitorConnectionProfileV1[];
	let listed = 0;
	const probe = await resolveSelectedToolsMonitor('video-upscale', 'default-app', {
		fetchImpl: fetchFrom([
			// Only profile a is probed: b is never in the path (no reroute).
			{ url: 'http://127.0.0.1:9902/v1/meta', res: ok({ capabilities: { tools: { srmd: true } } }) }
		]),
		listProfilesImpl: async () => {
			listed += 1;
			return profiles;
		},
		getSelectionMapImpl: async () => mapOf('video-upscale', {
			location: 'monitor-native',
			modelId: 'srmd-ncnn-vulkan',
			sourceId: 'srmd-ncnn-vulkan',
			variantId: 'ncnn-vulkan',
			monitorProfileId: 'a'
		})
	});
	assert.equal(probe.profileId, 'a');
	assert.equal(probe.srmd, true);
	assert.equal(probe.rife, false);
	assert.equal(listed, 1);
});

it('no selection is an error naming the settings path, never a reroute', async () => {
	await assert.rejects(
		resolveSelectedToolsMonitor('video-interpolate', 'default-app', depsFor([], EMPTY)),
		/Settings → AI models/
	);
});

it('an un-pinned pick resolves through the active monitor', async () => {
	const probe = await resolveSelectedToolsMonitor('audio-upsampling', 'default-app', depsFor(
		[{ id: 'c', name: 'Audio only', baseUrl: 'http://127.0.0.1:9903' }],
		mapOf('audio-upsampling', {
			location: 'monitor-native',
			modelId: 'audiosronnx',
			sourceId: 'audiosronnx',
			variantId: 'onnx-cpu'
		}),
		'c',
		[{ url: 'http://127.0.0.1:9903/v1/meta', res: ok({ capabilities: { tools: { audio: true } } }) }]
	));
	assert.equal(probe.profileId, 'c');
	assert.equal(probe.audio, true);
	assert.equal(probe.rife, false);
	assert.equal(probe.srmd, false);
});

it('a pick whose monitor lost the engine is an error, never a reroute', async () => {
	await assert.rejects(
		resolveSelectedToolsMonitor('video-upscale', 'default-app', depsFor(
			[{ id: 'a', name: 'Engine gone', baseUrl: 'http://127.0.0.1:9904' }],
			mapOf('video-upscale', {
				location: 'monitor-native',
				modelId: 'srmd-ncnn-vulkan',
				sourceId: 'srmd-ncnn-vulkan',
				variantId: 'ncnn-vulkan'
			}),
			'a',
			[{ url: 'http://127.0.0.1:9904/v1/meta', res: ok({ capabilities: { tools: { rife: true } } }) }]
		)),
		/Engine gone" has no srmd-ncnn-vulkan/
	);
});

it('a pick pinned to a deleted monitor is an error, never a reroute', async () => {
	await assert.rejects(
		resolveSelectedToolsMonitor('video-upscale', 'default-app', depsFor(
			[{ id: 'a', name: 'Still here', baseUrl: 'http://127.0.0.1:9901' }],
			mapOf('video-upscale', {
				location: 'monitor-native',
				modelId: 'srmd-ncnn-vulkan',
				sourceId: 'srmd-ncnn-vulkan',
				variantId: 'ncnn-vulkan',
				monitorProfileId: 'gone'
			})
		)),
		/is gone/
	);
});

it('rejects an audio run against a monitor without the audio engine', async () => {
	const { runMonitorToolJob } = await import('../src/monitor/toolsJobs.ts');
	const monitor = {
		profileId: 'x',
		name: 'Frames only',
		baseUrl: 'http://127.0.0.1:9904',
		rife: true,
		srmd: false,
		audio: false,
		jobsApi: false
	};
	const handle = {
		id: 'op-1',
		signal: new AbortController().signal,
		onCancelRequest: () => () => {},
		progress: () => {},
		cancelled: async () => {},
		cancel: () => {}
	} as never;
	await assert.rejects(
		runMonitorToolJob(
			handle,
			{ monitor, tool: 'audio', params: { engine: 'lavasr' }, body: new Blob(['a']) },
			() => {}
		),
		/audiosronnx not installed/
	);
});