import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
	probeToolsFeature,
	resolveSelectedToolsMonitor,
	buildToolSubmitUrl,
	toolRowPresent,
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
	fetches: FetchMock = []
) {
	return {
		fetchImpl: fetchFrom(fetches),
		listProfilesImpl: async () => profiles as MonitorConnectionProfileV1[],
		getSelectionMapImpl: async () => map
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
	assert.equal(caps.audioChunking, false);
	assert.equal(caps.jobsApi, false);
	assert.equal(caps.videoExport, false);
	assert.equal(caps.audioExport, false);
	assert.equal((requests[0].init as { targetAddressSpace?: string }).targetAddressSpace, 'loopback');
});

it('reads the UniverSR chunk capability and rejects an older monitor before uploading', async () => {
	const caps = await probeToolsFeature('http://127.0.0.1:9847', fetchFrom([
		{ url: 'http://127.0.0.1:9847/v1/meta', res: ok({ capabilities: { tools: { pytorch: true, audio_chunking: true } } }) }
	]));
	assert.equal(caps.audioChunking, true);
	const { createMonitorAudioTools } = await import('../src/monitor/toolsJobs.ts');
	const tools = createMonitorAudioTools({ monitor: {
		profileId: 'old', name: 'Old monitor', baseUrl: 'http://127.0.0.1:9847',
		rife: false, srmd: false, audio: false, pytorch: true, jobsApi: true
	} });
	await assert.rejects(tools.upsample(new Blob(['wav']), {
		engine: 'universr', chunkSeconds: 2.5, overlapSeconds: 0.1, id: 'job'
	}), /Update and restart this Monitor/);
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
	assert.equal(
		buildToolSubmitUrl('http://127.0.0.1:9847', 'audio', { engine: 'universr', chunk_seconds: '2.5', overlap_seconds: '0.1' }, 'job-4'),
		'http://127.0.0.1:9847/v1/tools/jobs/audio?engine=universr&chunk_seconds=2.5&overlap_seconds=0.1&id=job-4'
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

it('a pick that names no monitor is an error, never a guess', async () => {
	await assert.rejects(
		resolveSelectedToolsMonitor('audio-upsampling', 'default-app', depsFor(
			[{ id: 'c', name: 'Audio only', baseUrl: 'http://127.0.0.1:9903' }],
			mapOf('audio-upsampling', {
				location: 'monitor-native',
				modelId: 'audiosronnx',
				sourceId: 'audiosronnx',
				variantId: 'onnx-cpu'
			})
		)),
		/does not name a monitor/
	);
});

it('a pinned pick resolves on exactly its monitor', async () => {
	const probe = await resolveSelectedToolsMonitor('audio-upsampling', 'default-app', depsFor(
		[{ id: 'b', name: 'Other', baseUrl: 'http://127.0.0.1:9902' }, { id: 'c', name: 'Audio only', baseUrl: 'http://127.0.0.1:9903' }],
		mapOf('audio-upsampling', {
			location: 'monitor-native',
			modelId: 'audiosronnx',
			sourceId: 'audiosronnx',
			variantId: 'onnx-cpu',
			monitorProfileId: 'c'
		}),
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
				variantId: 'ncnn-vulkan',
				monitorProfileId: 'a'
			}),
			[
				{ url: 'http://127.0.0.1:9904/v1/meta', res: ok({ capabilities: { tools: { rife: true } } }) },
				{
					url: 'http://127.0.0.1:9904/v1/ai/catalog',
					res: ok({ offers: [{ id: 'tools:srmd', reason: 'SRMD (srmd-ncnn-vulkan) is not installed on this monitor. Download…' }] })
				}
			]
		)),
		// The daemon's own install steps, prefixed with the monitor's name.
		/Engine gone: SRMD \(srmd-ncnn-vulkan\) is not installed on this monitor/
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
		pytorch: false,
		jobsApi: false
	};
	let failed = 0;
	const handle = {
		id: 'op-1',
		signal: new AbortController().signal,
		onCancelRequest: () => () => {},
		progress: () => {},
		cancelled: async () => {},
		fail: async () => { failed += 1; },
		cancel: () => {}
	} as never;
	await assert.rejects(
		runMonitorToolJob(
			handle,
			{ monitor, tool: 'audio', params: { engine: 'lavasr' }, body: new Blob(['a']) },
			() => {}
		),
		/Frames only" cannot run audio \(not installed\)/
	);
	assert.equal(failed, 1);
});

it('a PyTorch engine needs the PyTorch runtime, not the ONNX CLI', async () => {
	const { runMonitorToolJob, toolRowKey, toolRowPresent } = await import('../src/monitor/toolsJobs.ts');
	assert.equal(toolRowKey('audio', 'universr'), 'universr');
	assert.equal(toolRowKey('audio', 'lavasr'), 'audio');
	assert.equal(toolRowKey('rife'), 'rife');
	const onnxOnly = { rife: false, srmd: false, audio: true, pytorch: false };
	assert.equal(toolRowPresent(onnxOnly, 'audio'), true);
	assert.equal(toolRowPresent(onnxOnly, 'audiosr'), false);
	const monitor = { profileId: 'x', name: 'ONNX only', baseUrl: 'http://127.0.0.1:9905', ...onnxOnly, jobsApi: false };
	let failed = 0;
	const handle = {
		id: 'op-2',
		signal: new AbortController().signal,
		onCancelRequest: () => () => {},
		progress: () => {},
		cancelled: async () => {},
		fail: async () => { failed += 1; },
		cancel: () => {}
	} as never;
	await assert.rejects(
		runMonitorToolJob(handle, { monitor, tool: 'audio', params: { engine: 'universr' }, body: new Blob(['a']) }, () => {}),
		/cannot run universr/
	);
	assert.equal(failed, 1);
});

it('uses catalog availability when an installed engine lacks FFmpeg', async () => {
	const { runMonitorToolJob, toolRowPresent, toolUnavailableReason } = await import('../src/monitor/toolsJobs.ts');
	const reason = 'ffmpeg or ffprobe is not installed. Install both commands.';
	const requests: FetchMock = [
		{ url: 'http://127.0.0.1:9906/v1/meta', res: ok({ capabilities: { tools: { srmd: true, audio: true, pytorch: true } } }) },
		{ url: 'http://127.0.0.1:9906/v1/ai/catalog', res: ok({ offers: ['srmd', 'audio', 'universr', 'audiosr'].map((key) => ({ id: `tools:${key}`, available: false, reason })) }) }
	];
	const caps = await probeToolsFeature('http://127.0.0.1:9906', fetchFrom(requests));
	for (const key of ['srmd', 'audio', 'universr', 'audiosr']) assert.equal(toolRowPresent(caps, key), false);
	assert.equal(await toolUnavailableReason({ ...caps, baseUrl: 'http://127.0.0.1:9906', name: 'Desktop' }, 'audio', fetchFrom([])), `Desktop: ${reason}`);
	let failed = 0;
	await assert.rejects(runMonitorToolJob({
		id: 'catalog-unavailable', signal: new AbortController().signal,
		fail: async () => { failed += 1; }
	} as never, {
		monitor: { ...caps, profileId: 'desktop', baseUrl: 'http://127.0.0.1:9906', name: 'Desktop' },
		tool: 'audio', params: { engine: 'audiosr' }, body: new Blob(['input'])
	}), /Desktop: ffmpeg or ffprobe is not installed/);
	assert.equal(failed, 1);
	await assert.rejects(resolveSelectedToolsMonitor('video-upscale', 'files', depsFor(
		[{ id: 'desktop', name: 'Desktop', baseUrl: 'http://127.0.0.1:9906' }],
		mapOf('video-upscale', { location: 'monitor-native', modelId: 'srmd-ncnn-vulkan', monitorProfileId: 'desktop' }),
		requests
	)), /Desktop: ffmpeg or ffprobe is not installed/);
});

it('a rejected submit fails the local operation with the daemon error', async (context) => {
	const { runMonitorToolJob } = await import('../src/monitor/toolsJobs.ts');
	context.mock.method(globalThis, 'fetch', async () => ok({ error: { code: 'tools.tool_unavailable', message: 'Install ffmpeg and ffprobe' } }, 409));
	let state = 'running';
	let failure: unknown;
	let unsubscribed = 0;
	const handle = {
		id: 'rejected-submit', signal: new AbortController().signal,
		onCancelRequest: () => () => { unsubscribed += 1; },
		fail: async (error: unknown) => { state = 'failed'; failure = error; },
		cancelled: async () => { state = 'cancelled'; }
	} as never;
	await assert.rejects(runMonitorToolJob(handle, {
		monitor: { profileId: 'desktop', name: 'Desktop', baseUrl: 'http://127.0.0.1:9907', rife: false, srmd: false, audio: true, pytorch: true, jobsApi: true },
		tool: 'audio', params: { engine: 'audiosr' }, body: new Blob(['input'])
	}), /tools.tool_unavailable: Install ffmpeg and ffprobe/);
	assert.equal(state, 'failed');
	assert.match(String(failure), /Install ffmpeg and ffprobe/);
	assert.equal(unsubscribed, 1);
});

it('audio status is unavailable when the catalog says FFmpeg is missing', async (context) => {
	const { createMonitorAudioTools } = await import('../src/monitor/toolsJobs.ts');
	const { saveProfile, deleteProfile, closeCredentialsDbForTests } = await import('../src/monitor/credentials.ts');
	const { setAiModelRef, closeSelectionDbForTests } = await import('../src/ai/selection.ts');
	const reason = 'ffmpeg or ffprobe is not installed. Install both commands.';
	context.mock.method(globalThis, 'fetch', fetchFrom([
		{ url: 'http://127.0.0.1:9909/v1/meta', res: ok({ capabilities: { tools: { audio: true, pytorch: true } } }) },
		{ url: 'http://127.0.0.1:9909/v1/ai/catalog', res: ok({ offers: ['audio', 'universr', 'audiosr'].map((key) => ({ id: `tools:${key}`, available: false, reason })) }) }
	]));
	await saveProfile({ id: 'status-desktop', name: 'Desktop', baseUrl: 'http://127.0.0.1:9909', rootPath: '/' });
	await setAiModelRef('audio-upsampling', 'missing-ffmpeg-test', { location: 'monitor-native', modelId: 'audiosr', sourceId: 'tools', variantId: 'pytorch', monitorProfileId: 'status-desktop' });
	try {
		const status = await createMonitorAudioTools({ app: 'missing-ffmpeg-test' }).checkStatus();
		assert.equal(status.audioPath, undefined);
		assert.equal(status.audioError, `Desktop: ${reason}`);
		assert.equal(status.defaultEngine, 'audiosr');
		assert.equal(status.unavailable?.audiosr, `Desktop: ${reason}`);
	} finally {
		await setAiModelRef('audio-upsampling', 'missing-ffmpeg-test', null);
		await deleteProfile('status-desktop');
		await closeCredentialsDbForTests();
		await closeSelectionDbForTests();
	}
});

it('lists runnable audio engines on saved monitors and skips one that does not answer', async () => {
	const { listRunnableAudioModels } = await import('../src/monitor/toolsJobs.ts');
	const reason = 'ffmpeg or ffprobe is not installed. Install both commands.';
	const requests: FetchMock = [
		{ url: 'http://127.0.0.1:9911/v1/meta', res: ok({ capabilities: { tools: { audio: true, pytorch: true } } }) },
		{ url: 'http://127.0.0.1:9911/v1/ai/catalog', res: ok({ offers: [
			{ id: 'tools:audio', available: true },
			{ id: 'tools:universr', available: false, reason },
			{ id: 'tools:audiosr', available: true }
		] }) },
		{ url: 'http://127.0.0.1:9912/v1/meta', res: ok({ error: { code: 'down', message: 'down' } }, 500) }
	];
	const { models, unreachable } = await listRunnableAudioModels({
		fetchImpl: fetchFrom(requests),
		listProfilesImpl: async () => [
			{ id: 'desktop', name: 'Desktop', baseUrl: 'http://127.0.0.1:9911' },
			{ id: 'laptop', name: 'Laptop', baseUrl: 'http://127.0.0.1:9912' }
		] as MonitorConnectionProfileV1[]
	});
	assert.deepEqual(models.map((model) => model.engineId), [
		'lavasr', 'novasr', 'sidon', 'callenhancer', 'hifiganbwe', 'apbwe', 'flowhigh', 'audiosr'
	]);
	assert.equal(models[0]?.monitor.profileId, 'desktop');
	assert.equal(models.some((model) => model.engineId === 'universr'), false);
	assert.deepEqual(unreachable, ['Laptop']);
});

it('a pinned monitor lists its audio engines without a saved default', async () => {
	const { createMonitorAudioTools } = await import('../src/monitor/toolsJobs.ts');
	const status = await createMonitorAudioTools({
		app: 'pinned-audio',
		monitor: {
			profileId: 'desktop',
			name: 'Desktop',
			baseUrl: 'http://127.0.0.1:9913',
			rife: false,
			srmd: false,
			audio: true,
			pytorch: false,
			jobsApi: true,
			toolOffers: {
				audio: { available: true },
				universr: { available: false, reason: 'no pytorch' },
				audiosr: { available: false, reason: 'no pytorch' }
			}
		}
	}).checkStatus();
	assert.equal(status.audioPath, 'monitor:Desktop');
	assert.equal(status.defaultEngine, 'lavasr');
	assert.equal(status.unavailable?.lavasr, undefined);
	assert.equal(status.unavailable?.audiosr, 'Desktop: no pytorch');
});

it('a cancelled unavailable run closes as cancelled without submitting or failing', async (context) => {
	const { runMonitorToolJob } = await import('../src/monitor/toolsJobs.ts');
	let requests = 0;
	context.mock.method(globalThis, 'fetch', async () => { requests += 1; throw new Error('No network request expected'); });
	const controller = new AbortController(); controller.abort();
	let cancelled = 0;
	let failed = 0;
	const handle = {
		id: 'cancelled-run', signal: controller.signal,
		fail: async () => { failed += 1; },
		cancelled: async () => { cancelled += 1; }
	} as never;
	await assert.rejects(runMonitorToolJob(handle, {
		monitor: { profileId: 'desktop', name: 'Desktop', baseUrl: 'http://127.0.0.1:9908', rife: false, srmd: false, audio: false, pytorch: false, jobsApi: true },
		tool: 'audio', params: { engine: 'audiosr' }, body: new Blob(['input'])
	}), /Job aborted/);
	assert.equal(cancelled, 1);
	assert.equal(failed, 0);
	assert.equal(requests, 0);
});


it('only offers general export when the monitor explicitly advertises its route', async () => {
    const caps = await probeToolsFeature('http://127.0.0.1:9847', fetchFrom([
        { url: 'http://127.0.0.1:9847/v1/meta', res: ok({ capabilities: { tools: { videoExport: true } } }) }
    ]));
    assert.equal(caps.videoExport, true);
    assert.equal(toolRowPresent({ rife: false, srmd: false, audio: false, pytorch: false, videoExport: true }, 'export'), true);
    assert.equal(toolRowPresent({ rife: true, srmd: true, audio: true, pytorch: true }, 'export'), false);
    assert.equal(buildToolSubmitUrl('http://127.0.0.1:9847', 'export', {}, 'job-9'), 'http://127.0.0.1:9847/v1/tools/jobs/export?id=job-9');
});

it('requires the audio export capability independently of AI upsampling', async () => {
    const caps = await probeToolsFeature('http://127.0.0.1:9847', fetchFrom([
        { url: 'http://127.0.0.1:9847/v1/meta', res: ok({ capabilities: { tools: { audioExport: true } } }) }
    ]));
    assert.equal(caps.audioExport, true);
    assert.equal(caps.audio, false);
    assert.equal(toolRowPresent({ rife: false, srmd: false, audio: false, pytorch: false, audioExport: true }, 'audio-export'), true);
    assert.equal(toolRowPresent({ rife: false, srmd: false, audio: true, pytorch: true }, 'audio-export'), false);
    assert.match(buildToolSubmitUrl('http://127.0.0.1:9847', 'audio-export', { start: '1', end: '2', format: 'flac' }, 'job-9'), /\/jobs\/audio-export\?start=1&end=2&format=flac&id=job-9$/);
});
