/**
 * Shared transport for monitor GPU tool jobs (RIFE / SRMD) — the move of
 * sign-dictionary's app-local `monitorTools.ts` (Phase 2 of
 * connections/docs/design/tools-ai-integration-plan.md). Import from
 * `@shared-packages/file-system/monitor`.
 *
 * Monitors are discovered from the hub's monitor connection profiles
 * (IndexedDB — same origin as the caller), gated on `capabilities.tools.*`
 * from `GET /v1/meta`. Transport is `fetch` annotated for Local Network
 * Access via `withLocalAddressSpace`. No tokens: tool jobs are
 * loopback-internal end to end.
 *
 * Lifecycle follows the unified jobs view (W7) whenever the monitor offers
 * `capabilities.jobs`: the submit carries the caller's id as the optional
 * `?id=` param (the daemon's clientRequestId), so the op record the caller
 * created with `opsService().start({ kind: 'video', id })` is the same row the
 * W8 monitor link feeds into every tab (`monitorLink.ts` maps `rife`/`srmd`
 * to the `video` op). Terminal state comes from that op record — never
 * per-tab polling (W8.5: the loopback HTTP/1.1 budget is already tight with
 * the three long-lived streams per monitor). Monitors without
 * `capabilities.jobs` fall back to the legacy per-tab NDJSON stream (W7.7).
 *
 * The result is fetched from `/v1/tools/jobs/{jobId}/result` and, when the
 * caller asked for no landing, staged into the op record so "Save to…"
 * keeps working after the daemon-side copy is released: tools jobs hold
 * their result until `landed` (W7), which `finishMonitorToolJob` requests
 * once the bytes are staged — `monitorLink.ts` auto-acks only `fs`/`b2`.
 */

import { withLocalAddressSpace } from './localNetwork.js';
import { listProfiles } from './credentials.js';
import { createMonitorJobsClient } from './jobs.js';
import type { MonitorConnectionProfileV1 } from './types.js';
import { opsService, startOp, type OpHandle, type ResultRef } from '../services/ops.js';
import { stageOpResult } from '../services/landing.js';

/** One NDJSON progress tick (frozen shape, monitor tools-feature.md §4.2). */
export type MonitorToolProgress = {
	jobId: string;
	state:
		| 'uploading'
		| 'probing'
		| 'extracting'
		| 'running'
		| 'assembling'
		| 'done'
		| 'failed'
		| 'aborted';
	phase?: string;
	percent?: number;
	error?: string;
};

export type MonitorToolsProbe = {
	profileId: string;
	name: string;
	baseUrl: string;
	rife: boolean;
	srmd: boolean;
	/** `capabilities.jobs` — the unified lifecycle (W7); false → NDJSON fallback. */
	jobsApi: boolean;
};

// Last error seen per server job id (the failed tick carries the detail).
const legacyErrors = new Map<string, string>();

function legacyErrorKey(baseUrl: string, jobId: string): string {
	return `${baseUrl.replace(/\/$/, '')}:${jobId}`;
}

async function throwEnvelopeError(res: Response, fallback: string): Promise<never> {
	let detail = fallback;
	try {
		const body = (await res.json()) as { error?: { code?: string; message?: string } };
		if (body?.error?.code) detail = `${body.error.code}: ${body.error.message || res.status}`;
	} catch {
		/* keep the fallback */
	}
	throw new Error(detail);
}

/** `GET /v1/meta` on a monitor, with the Local Network Access annotation. */
export async function probeToolsFeature(
	baseUrl: string,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal
): Promise<{ rife: boolean; srmd: boolean; jobsApi: boolean }> {
	const url = `${baseUrl.replace(/\/$/, '')}/v1/meta`;
	const res = await fetchImpl(url, withLocalAddressSpace(url, { signal }));
	if (!res.ok) {
		await throwEnvelopeError(res, `Monitor meta failed: ${res.status}`);
	}
	const meta = (await res.json()) as {
		capabilities?: { tools?: { rife?: boolean; srmd?: boolean }; jobs?: boolean };
	};
	const tools = meta.capabilities?.tools;
	// Missing key = false (mixed-version rule).
	return { rife: !!tools?.rife, srmd: !!tools?.srmd, jobsApi: meta.capabilities?.jobs === true };
}

/**
 * Resolve the monitor to run tool jobs on: the preferred profile if it is
 * tools-capable and reachable, else the first tools-capable profile
 * (`listProfiles` returns most-recently-updated first). Interim behaviour —
 * the Phase 4 plan replaces the auto-route with explicit per-task selection.
 */
export async function resolveToolsMonitor(
	preferredProfileId?: string | null,
	fetchImpl: typeof fetch = fetch,
	listProfilesImpl: typeof listProfiles = listProfiles
): Promise<MonitorToolsProbe> {
	let profiles: MonitorConnectionProfileV1[] = [];
	try {
		profiles = await listProfilesImpl();
	} catch (err) {
		throw new Error(`Could not read configured monitors: ${(err as Error)?.message || err}`);
	}
	const ordered = preferredProfileId
		? [
				...profiles.filter((p) => p.id === preferredProfileId),
				...profiles.filter((p) => p.id !== preferredProfileId)
			]
		: profiles;
	for (const p of ordered) {
		try {
			const caps = await probeToolsFeature(p.baseUrl, fetchImpl);
			if (caps.rife || caps.srmd) {
				return {
					profileId: p.id,
					name: p.name,
					baseUrl: p.baseUrl.replace(/\/$/, ''),
					rife: caps.rife,
					srmd: caps.srmd,
					jobsApi: caps.jobsApi
				};
			}
		} catch {
			/* unreachable monitor: try the next profile */
		}
	}
	if (profiles.length === 0) {
		throw new Error('No monitors configured. Add one in the File Explorer settings.');
	}
	throw new Error('No reachable monitor has the tools feature (rife/srmd binaries missing?).');
}

/** Client-generated submit id (`?id=`) — doubles as the caller's op id. */
export function newMonitorToolRequestId(): string {
	return crypto.randomUUID();
}

/**
 * The submit URL. `params` are the tool's query parameters (fps for rife;
 * scale / noise / model for srmd); `id` is the caller's client-generated id,
 * which the unified jobs view reports back as `clientRequestId` and the
 * daemon accepts when it matches its job-id jail.
 */
export function buildToolSubmitUrl(
	baseUrl: string,
	tool: 'rife' | 'srmd',
	params: Record<string, string>,
	id: string
): string {
	const base = baseUrl.replace(/\/$/, '');
	const qs = new URLSearchParams({ ...params, id });
	return `${base}/v1/tools/jobs/${tool}?${qs.toString()}`;
}

/** POST the job; resolves the daemon-side jobId from the 202 envelope. */
export async function submitMonitorToolJob(
	input: {
		baseUrl: string;
		tool: 'rife' | 'srmd';
		params: Record<string, string>;
		id: string;
		body: Blob;
		signal?: AbortSignal;
	},
	fetchImpl: typeof fetch = fetch
): Promise<string> {
	const submitUrl = buildToolSubmitUrl(input.baseUrl, input.tool, input.params, input.id);
	const submitRes = await fetchImpl(
		submitUrl,
		withLocalAddressSpace(submitUrl, { method: 'POST', body: input.body, signal: input.signal })
	);
	if (!submitRes.ok) {
		await throwEnvelopeError(submitRes, `Tool job submit failed: ${submitRes.status}`);
	}
	const { jobId } = (await submitRes.json()) as { jobId: string };
	return jobId;
}

/** GET the finished MP4 from the daemon. */
export async function fetchMonitorToolResult(
	baseUrl: string,
	jobId: string,
	fetchImpl: typeof fetch = fetch
): Promise<Blob> {
	const base = baseUrl.replace(/\/$/, '');
	const resultUrl = `${base}/v1/tools/jobs/${encodeURIComponent(jobId)}/result`;
	const resultRes = await fetchImpl(resultUrl, withLocalAddressSpace(resultUrl));
	if (!resultRes.ok) {
		await throwEnvelopeError(resultRes, `Tool job result failed: ${resultRes.status}`);
	}
	return await resultRes.blob();
}

/**
 * Read the NDJSON progress stream (the legacy fallback monitor's only
 * channel) until a terminal state; calls `onTick` per tick. Returns the
 * terminal state; throws when the stream ends without one.
 */
export async function readMonitorToolProgressNdjson(
	baseUrl: string,
	jobId: string,
	onTick: (tick: MonitorToolProgress) => void,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal
): Promise<'done' | 'failed' | 'aborted'> {
	const base = baseUrl.replace(/\/$/, '');
	const url = `${base}/v1/tools/jobs/${encodeURIComponent(jobId)}/progress`;
	const res = await fetchImpl(url, withLocalAddressSpace(url, { signal }));
	if (!res.ok || !res.body) {
		await throwEnvelopeError(res, `Tool job progress failed: ${res.status}`);
	}
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (value) buffer += decoder.decode(value, { stream: true });
		let newline = buffer.indexOf('\n');
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf('\n');
			if (!line) continue;
			let tick: MonitorToolProgress;
			try {
				tick = JSON.parse(line) as MonitorToolProgress;
			} catch {
				continue; // tolerate a torn line (additive evolution rule)
			}
			onTick(tick);
			if (tick.error) legacyErrors.set(legacyErrorKey(base, jobId), tick.error);
			if (tick.state === 'done' || tick.state === 'failed' || tick.state === 'aborted') {
				const state = tick.state;
				reader.cancel().catch(() => {});
				return state;
			}
		}
		if (done) {
			// Stream closed without a terminal tick: job lost (restart/reap).
			throw new Error('Progress stream ended without a terminal state');
		}
	}
}

/**
 * Legacy single-run fallback (monitor without `capabilities.jobs`, W7.7):
 * submit, stream the NDJSON progress into `onTick`, then fetch the result.
 * Progress pumps into the caller's op record inside `runMonitorToolJob`.
 */
export async function runMonitorToolLegacy(
	input: {
		baseUrl: string;
		tool: 'rife' | 'srmd';
		params: Record<string, string>;
		id: string;
		body: Blob;
		signal?: AbortSignal;
	},
	onTick: (tick: MonitorToolProgress) => void,
	fetchImpl: typeof fetch = fetch
): Promise<{ blob: Blob; jobId: string }> {
	const jobId = await submitMonitorToolJob(input, fetchImpl);
	const state = await readMonitorToolProgressNdjson(
		input.baseUrl,
		jobId,
		onTick,
		fetchImpl,
		input.signal
	);
	if (state === 'failed')
		throw new Error(legacyErrors.get(legacyErrorKey(input.baseUrl, jobId)) || 'job failed');
	if (state === 'aborted') throw new Error('Job aborted');
	return { blob: await fetchMonitorToolResult(input.baseUrl, jobId, fetchImpl), jobId };
}

/**
 * Wait on the unified ops feed for the tool job's terminal state: the submit
 * used `opId` as the `?id=` client request id, so the W8 monitor link imports
 * the daemon's row into the op record `opsService()` holds. No extra channel —
 * the single elected link's `/v1/jobs` SSE feeds every tab.
 */
export async function waitForMonitorToolJob(
	opId: string,
	onProgress?: (percent: number, note?: string) => void
): Promise<void> {
	const service = await opsService();
	const verdictOf = (): 'pending' | 'ok' | Error => {
		const record = service.get(opId);
		if (!record) return 'pending';
		if (onProgress) {
			const p = service.progressOf(opId);
			if (p) onProgress(p.total ? Math.round((p.done / (p.total || 100)) * 100) : p.done, p.note);
		}
		if (record.state === 'done' || record.state === 'landed') return 'ok';
		if (record.state === 'failed') return new Error(record.error || 'Monitor job failed');
		if (record.state === 'cancelled' || record.state === 'stopped')
			return new Error(record.error || 'Job aborted');
		return 'pending';
	};
	const first = verdictOf();
	if (first !== 'pending') {
		if (first === 'ok') return;
		throw first;
	}
	await new Promise<void>((resolve, reject) => {
		const stop = service.subscribe(() => {
			try {
				const verdict = verdictOf();
				if (verdict === 'pending') return;
				stop();
				if (verdict === 'ok') resolve();
				else reject(verdict);
			} catch (error) {
				stop();
				reject(error);
			}
		});
	});
}

/**
 * Run one tool job against the resolved monitor, bound to the caller's op:
 * submit with `?id=` = the op id (so the W8 link imports the same row), then
 * wait — jobs-API mode waits on the ops feed; legacy mode runs the one
 * per-tab NDJSON stream and pumps it into the op record's progress. Resolves
 * with the result MP4 bytes and the daemon-side job id.
 *
 * Finishing (staging the bytes, acking the daemon) is `finishMonitorToolJob`
 * so landing-capable callers can substitute their own `finishMediaOp`.
 */
export async function runMonitorToolJob(
	handle: OpHandle,
	input: {
		monitor: MonitorToolsProbe;
		tool: 'rife' | 'srmd';
		params: Record<string, string>;
		body: Blob;
	},
	onTick: (tick: MonitorToolProgress) => void = () => {}
): Promise<{ blob: Blob; jobId: string }> {
	const { monitor, tool, params } = input;
	if (tool === 'rife' && !monitor.rife)
		throw new Error('This monitor has no RIFE (rife-ncnn-vulkan not installed).');
	if (tool === 'srmd' && !monitor.srmd)
		throw new Error('This monitor has no SRMD (srmd-ncnn-vulkan not installed).');
	const jobs = createMonitorJobsClient(monitor.baseUrl);
	let jobId: string | null = null;
	try {
		// Best-effort abort for a cancel that arrives after the submit but
		// while this tab still owns the job (the W8 leader takes over once
		// the feed imports the record).
		const stopFallbackCancel = handle.onCancelRequest(() => {
			if (jobId && monitor.jobsApi) void jobs.abort(`tools:${jobId}`).catch(() => {});
		});
		handle.signal.addEventListener('abort', () => stopFallbackCancel(), { once: true });

		jobId = await submitMonitorToolJob(
			{ baseUrl: monitor.baseUrl, tool, params, id: handle.id, body: input.body, signal: handle.signal }
		);

		if (monitor.jobsApi) {
			// Progress and terminal state ride the W8 job feed into the op
			// record; this wait opens no second channel.
			await waitForMonitorToolJob(handle.id);
		} else {
			// Legacy fallback (W7.7): one per-tab NDJSON progress stream, pumped
			// into the op record so `pollProgress` subscribers still see ticks.
			const legacy = await runMonitorToolLegacy(
				{ baseUrl: monitor.baseUrl, tool, params, id: handle.id, body: input.body, signal: handle.signal },
				(tick) => {
					onTick(tick);
					if (tick.percent !== undefined)
						handle.progress({ done: tick.percent, total: 100, note: tick.phase });
				}
			);
			return legacy;
		}
		const blob = await fetchMonitorToolResult(monitor.baseUrl, jobId);
		return { blob, jobId };
	} catch (error) {
		if (handle.signal.aborted) {
			await handle.cancelled();
			throw new Error('Job aborted');
		}
		if (jobId && monitor.jobsApi) {
			// The feed may still be reconciling; ask the daemon to abort so a
			// half-submitted job cannot linger with no observer.
			try {
				await jobs.abort(`tools:${jobId}`);
			} catch {
				/* best effort */
			}
		}
		throw error;
	}
}

/**
 * Finish a tool job whose bytes the caller keeps: stage them into the op
 * record (the record's result keeps working for "Save to…"), mark the op
 * done, and tell the daemon it may drop its copy (tools results are held
 * until `landed`, and no landing address was requested). Returns the staged
 * result reference; the ack failure is non-fatal (the daemon keeps its copy
 * and the ack is retried the next time any tab re-acknowledges the op).
 */
export async function finishMonitorToolJob(
	handle: OpHandle,
	blob: Blob,
	input: { monitor: MonitorToolsProbe; jobId: string }
): Promise<ResultRef | undefined> {
	if (handle.signal.aborted) {
		await handle.cancelled();
		return undefined;
	}
	const ref = await stageOpResult(handle.id, blob);
	await handle.done(ref, false);
	if (input.monitor.jobsApi) {
		try {
			await createMonitorJobsClient(input.monitor.baseUrl).landed(`tools:${input.jobId}`);
			const service = await opsService();
			const profileId = input.monitor.profileId;
			await service.change(handle.id, (current) =>
				current.owner.kind === 'monitor' && current.owner.profileId === profileId
					? { ...current, monitorAcknowledged: true }
					: current
			);
		} catch (error) {
			console.warn('Monitor acknowledgement will be retried when it is reachable', error);
		}
	}
	return ref;
}

/**
 * The video-package tool contracts on one monitor: one probe, job ids that
 * are op ids (`newJobId()` → `pollProgress(id)` → run with the same id),
 * progress driven by the ops record (feed-driven, or legacy-NDJSON pumped),
 * and interpolate/upscale runs that create and finish their own
 * `kind: 'video'` op. Structurally satisfies `VideoInterpolator` /
 * `VideoUpscaler` in `@shared-packages/video`.
 */
export type MonitorVideoToolsOptions = {
	/** Preferred monitor profile — the explicit selection (interim: a pinned profile id). */
	preferredProfileId?: () => string | null;
	/** Attributed app surface for the op records (free-form, shown by ops UI). */
	app?: string;
};

export type MonitorVideoTools = {
	checkStatus: () => Promise<{ rifePath?: string; srmdPath?: string }>;
	newJobId: () => string;
	pollProgress: (id: string, onProgress: (n: number) => void) => () => void;
	interpolate: (blob: Blob, opts: { fps: number; id: string }) => Promise<Blob>;
	upscale: (
		blob: Blob,
		opts: { scale: number; noise?: number; model?: string; id: string }
	) => Promise<Blob>;
	cancel: (id: string) => Promise<void>;
};

export function createMonitorVideoTools(options: MonitorVideoToolsOptions = {}): MonitorVideoTools {
	const preferredProfileId = options.preferredProfileId ?? (() => null);
	const app = options.app ?? 'files';
	async function resolve(): Promise<MonitorToolsProbe> {
		return await resolveToolsMonitor(preferredProfileId());
	}
	async function run(
		blob: Blob,
		tool: 'rife' | 'srmd',
		params: Record<string, string>,
		id: string,
		title: string
	): Promise<Blob> {
		const monitor = await resolve();
		const handle = await startOp({
			kind: 'video',
			app,
			title,
			where: { executor: 'monitor', note: monitor.name },
			id
		});
		const { blob: result, jobId } = await runMonitorToolJob(handle, { monitor, tool, params, body: blob });
		await finishMonitorToolJob(handle, result, { monitor, jobId });
		return result;
	}
	return {
		checkStatus: async () => {
			const monitor = await resolve();
			return {
				rifePath: monitor.rife ? `monitor:${monitor.name}` : undefined,
				srmdPath: monitor.srmd ? `monitor:${monitor.name}` : undefined
			};
		},
		newJobId: newMonitorToolRequestId,
		pollProgress(id, onProgress) {
			let last: number | null = null;
			let stopped = false;
			let unsubscribe: (() => void) | undefined;
			void opsService()
				.then((service) => {
					if (stopped) return;
					const check = () => {
						const p = service.progressOf(id);
						if (!p) {
							// Before the submit: no record yet; polling order preserved.
							return;
						}
						const n = p.total
							? Math.min(100, Math.round((p.done / (p.total || 100)) * 100))
							: Math.round(p.done);
						if (n !== last) {
							last = n;
							onProgress(n);
						}
					};
					check();
					unsubscribe = service.subscribe(check);
				})
				.catch(() => {});
			return () => {
				stopped = true;
				unsubscribe?.();
			};
		},
		interpolate: (blob, opts) =>
			run(blob, 'rife', { fps: String(opts.fps) }, opts.id, `Interpolate · ${opts.fps} fps`),
		upscale: (blob, opts) =>
			run(
				blob,
				'srmd',
				{
					scale: String(opts.scale),
					...(opts.noise !== undefined ? { noise: String(opts.noise) } : {}),
					...(opts.model ? { model: opts.model } : {})
				},
				opts.id,
				`Upscale · ${opts.scale}×`
			),
		cancel: async (id) => {
			(await opsService()).cancel(id);
		}
	};
}