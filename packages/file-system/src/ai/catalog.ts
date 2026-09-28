/** Task and execution-location catalog supplied by a monitor. Browser offers
 * are assembled by the consuming task UI from its own local engine catalog. */
import { withLocalAddressSpace } from '../monitor/localNetwork.js';
import { createMonitorClient } from '../monitor/client.js';
import { getActiveProfileId, listProfiles } from '../monitor/credentials.js';
import { AiCredentialsError, toAiCredentialsError } from './errors.js';

export type AiTask = 'chat' | 'text-to-speech' | 'image-generation' | 'transcription';
export type AiLocation = 'browser' | 'monitor-native' | 'monitor-provider';
export type AiDeviceClass = 'cpu' | 'gpu' | 'service';

export type AiOffer = {
	id: string;
	name: string;
	task: AiTask;
	location: AiLocation;
	modelId: string;
	sourceId: string;
	variantId: string;
	deviceClass: AiDeviceClass;
	supported: boolean;
	ready: boolean;
	available: boolean;
	reason: string | null;
	/** Model file size on disk, when the monitor reports it (native offers). */
	diskBytes?: number;
	/** Wall time of the most recent completed native job for this model —
	 * a measurement on that machine, never a promised rate. */
	lastRunMs?: number;
};

export type AiCatalog = {
	offers: AiOffer[];
	errors: Array<{ profile: string; code: string; message: string }>;
};

/** Native jobs always use the active monitor connection. A failed active
 * monitor is reported rather than silently moving work to another PC. */
export async function resolveNativeAiMonitor(): Promise<{ profileId: string; name: string; baseUrl: string }> {
	const activeId = await getActiveProfileId();
	const profiles = await listProfiles();
	const profile = (activeId ? profiles.find((row) => row.id === activeId) : profiles[0]) ?? null;
	if (!profile) throw new AiCredentialsError('AI_NOT_FOUND', 'Select a monitor connection first.');
	const meta = await createMonitorClient({ baseUrl: profile.baseUrl }).meta();
	if (meta.capabilities?.ai?.nativeJobs !== true) {
		throw new AiCredentialsError('AI_UNSUPPORTED', 'The selected monitor needs an update to run AI models.');
	}
	return { profileId: profile.id, name: profile.name, baseUrl: profile.baseUrl };
}

export type AiNativeProgress = {
	jobId: string;
	state: 'running' | 'done' | 'failed' | 'aborted';
	error?: string | null;
	seed?: number | null;
};

function url(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

async function request(baseUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
	const target = url(baseUrl, path);
	let response: Response;
	try {
		response = await fetch(target, withLocalAddressSpace(target, init));
	} catch (error) {
		throw toAiCredentialsError(error);
	}
	if (!response.ok) {
		let message = `Monitor AI request failed (${response.status})`;
		try {
			const body = (await response.json()) as { error?: { message?: string } };
			if (body.error?.message) message = body.error.message;
		} catch { /* preserve status */ }
		const code = response.status === 401 || response.status === 403 ? 'AI_AUTH'
			: response.status === 429 ? 'AI_RATE'
			: response.status === 404
			? (path === '/v1/ai/catalog' ? 'AI_UNSUPPORTED' : 'AI_NOT_FOUND')
			: response.status === 409 ? 'AI_BUSY' : 'AI_ERROR';
		throw new AiCredentialsError(code, message, response.status);
	}
	return response;
}

export type AiChatMessage = {
	role: 'system' | 'user' | 'assistant';
	content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
};

/** Raw completion for task adapters that use content parts beyond text/image. */
export async function requestAiChatCompletion(
	baseUrl: string,
	body: object,
	profileId?: string | null,
	signal?: AbortSignal
): Promise<unknown> {
	const suffix = profileId ? `?profile=${encodeURIComponent(profileId)}` : '';
	const response = await request(baseUrl, `/v1/ai/chat/completions${suffix}`, {
		method: 'POST', headers: { 'content-type': 'application/json' }, signal,
		body: JSON.stringify(body)
	});
	try { return await response.json(); }
	catch { throw new AiCredentialsError('AI_ERROR', 'The monitor returned a non-JSON response.'); }
}

/** Shared chat transport and response parsing for Hub, Creative, and Documents. */
export async function completeAiChat(
	baseUrl: string,
	input: { model: string; messages: AiChatMessage[]; maxTokens: number; profileId?: string | null },
	signal?: AbortSignal
): Promise<{ text: string; thinking: string | null }> {
	const body = await requestAiChatCompletion(baseUrl, {
		model: input.model, messages: input.messages, max_tokens: input.maxTokens
	}, input.profileId, signal) as {
		choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }>
	};
	const message = body?.choices?.[0]?.message;
	if (typeof message?.content !== 'string' || !message.content.trim()) {
		throw new AiCredentialsError('AI_ERROR', 'The AI server returned an empty reply.');
	}
	const thinking = [message.reasoning_content, message.reasoning]
		.find((value) => typeof value === 'string' && value.trim());
	return { text: message.content.trim(), thinking: typeof thinking === 'string' ? thinking.trim() : null };
}

function offer(raw: unknown): AiOffer | null {
	if (!raw || typeof raw !== 'object') return null;
	const row = raw as Record<string, unknown>;
	if (typeof row.id !== 'string' || typeof row.name !== 'string' ||
		typeof row.modelId !== 'string' || typeof row.sourceId !== 'string' ||
		typeof row.variantId !== 'string') return null;
	if (!['chat', 'text-to-speech', 'image-generation', 'transcription'].includes(String(row.task))) return null;
	if (!['browser', 'monitor-native', 'monitor-provider'].includes(String(row.location))) return null;
	if (!['cpu', 'gpu', 'service'].includes(String(row.deviceClass))) return null;
	const parsed: AiOffer = {
		id: row.id, name: row.name, task: row.task as AiTask,
		location: row.location as AiLocation, modelId: row.modelId,
		sourceId: row.sourceId, variantId: row.variantId,
		deviceClass: row.deviceClass as AiDeviceClass,
		supported: row.supported === true, ready: row.ready === true,
		available: row.available === true,
		reason: typeof row.reason === 'string' ? row.reason : null
	};
	// Optional estimates: present only on native offers that report them.
	if (typeof row.diskBytes === 'number' && Number.isFinite(row.diskBytes) && row.diskBytes >= 0) {
		parsed.diskBytes = row.diskBytes;
	}
	if (typeof row.lastRunMs === 'number' && Number.isFinite(row.lastRunMs) && row.lastRunMs >= 0) {
		parsed.lastRunMs = row.lastRunMs;
	}
	return parsed;
}

/** A monitor with no configured native models still lists provider chat offers. */
export async function listAiOffers(baseUrl: string, signal?: AbortSignal): Promise<AiCatalog> {
	const response = await request(baseUrl, '/v1/ai/catalog', { signal });
	const body = (await response.json()) as { offers?: unknown; errors?: unknown };
	return {
		offers: Array.isArray(body.offers) ? body.offers.flatMap((row) => { const parsed = offer(row); return parsed ? [parsed] : []; }) : [],
		errors: Array.isArray(body.errors) ? body.errors.filter((row): row is AiCatalog['errors'][number] =>
			!!row && typeof row.profile === 'string' && typeof row.code === 'string' && typeof row.message === 'string') : []
	};
}

/** Submit monitor-owned speech/image work, wait for completion, and fetch its
 * binary result. Aborting also asks the daemon to kill the running process. */
export async function runAiNativeJob(
	baseUrl: string,
	input: {
		offerId: string;
		text?: string;
		prompt?: string;
		seed?: number;
		speed?: number;
		/** Transcription only: base64 WAV (16 kHz mono recommended). */
		audioBase64?: string;
		/** Transcription only: a language code, or 'auto'. */
		language?: string;
	},
	opts: { signal?: AbortSignal; onProgress?: (progress: AiNativeProgress) => void } = {}
): Promise<{ blob: Blob; seed: number | null }> {
	const submit = await request(baseUrl, '/v1/ai/jobs', {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input), signal: opts.signal
	});
	const { jobId } = (await submit.json()) as { jobId?: string };
	if (!jobId) throw new AiCredentialsError('AI_ERROR', 'Monitor did not return a job id.');
	const path = `/v1/ai/jobs/${encodeURIComponent(jobId)}`;
	let aborted = false;
	const abortOnServer = () => {
		aborted = true;
		void request(baseUrl, `${path}/abort`, { method: 'POST' }).catch(() => {});
	};
	opts.signal?.addEventListener('abort', abortOnServer, { once: true });
	if (opts.signal?.aborted) abortOnServer();
	try {
		for (;;) {
			if (opts.signal?.aborted || aborted) throw new DOMException('Job aborted', 'AbortError');
			const response = await request(baseUrl, path, { signal: opts.signal });
			const progress = (await response.json()) as AiNativeProgress;
			opts.onProgress?.(progress);
			if (progress.state === 'failed') throw new AiCredentialsError('AI_ERROR', progress.error || 'Monitor inference failed.');
			if (progress.state === 'aborted') throw new DOMException('Job aborted', 'AbortError');
			if (progress.state === 'done') {
				const result = await request(baseUrl, `${path}/result`, { signal: opts.signal });
				return { blob: await result.blob(), seed: typeof progress.seed === 'number' ? progress.seed : null };
			}
			await new Promise<void>((resolve, reject) => {
				let timer: ReturnType<typeof setTimeout>;
				const onAbort = () => { clearTimeout(timer); reject(new DOMException('Job aborted', 'AbortError')); };
				timer = setTimeout(() => { opts.signal?.removeEventListener('abort', onAbort); resolve(); }, 750);
				opts.signal?.addEventListener('abort', onAbort, { once: true });
				if (opts.signal?.aborted) onAbort();
			});
		}
	} catch (error) {
		// A failed poll or result transfer leaves a server job running unless we
		// explicitly cancel it. Aborting an already finished job is harmless.
		if (!aborted) abortOnServer();
		throw error;
	} finally {
		opts.signal?.removeEventListener('abort', abortOnServer);
	}
}

/** Run a media offer using its declared execution location. Provider calls
 * return bytes directly; native calls use the monitor's cancellable job API. */
export async function runAiMedia(
	baseUrl: string,
	offer: AiOffer,
	input: { text?: string; prompt?: string; speed?: number; seed?: number },
	opts: { signal?: AbortSignal; onProgress?: (progress: AiNativeProgress) => void } = {}
): Promise<{ blob: Blob; seed: number | null }> {
	if (offer.location === 'monitor-native') {
		return runAiNativeJob(baseUrl, { offerId: offer.id, ...input }, opts);
	}
	if (offer.location !== 'monitor-provider' || !['text-to-speech', 'image-generation'].includes(offer.task)) {
		throw new AiCredentialsError('AI_UNSUPPORTED', 'This offer cannot run as a media task.');
	}
	const path = offer.task === 'image-generation' ? '/v1/ai/images/generations' : '/v1/ai/audio/speech';
	const response = await request(baseUrl, path, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ offerId: offer.id, ...input }), signal: opts.signal
	});
	return { blob: await response.blob(), seed: null };
}

/** Run a transcription offer and return its transcript text. Native offers
 * submit a base64 WAV job (same lifecycle as speech and image); provider
 * offers upload through the monitor's transcription adapter. Aborting a
 * native job also asks the daemon to kill the runtime. Callers pass an
 * offer filtered to the transcription task; the monitor revalidates it. */
export async function runAiTranscription(
	baseUrl: string,
	offer: Pick<AiOffer, 'id' | 'location' | 'task'>,
	input: { audioBase64: string; language?: string },
	opts: { signal?: AbortSignal; onProgress?: (progress: AiNativeProgress) => void } = {}
): Promise<{ text: string }> {
	if (offer.task !== 'transcription') {
		throw new AiCredentialsError('AI_UNSUPPORTED', 'This offer cannot transcribe audio.');
	}
	if (offer.location === 'monitor-native') {
		const result = await runAiNativeJob(
			baseUrl,
			{ offerId: offer.id, audioBase64: input.audioBase64, language: input.language },
			opts
		);
		return { text: (await result.blob.text()).trim() };
	}
	if (offer.location !== 'monitor-provider') {
		throw new AiCredentialsError('AI_UNSUPPORTED', 'This offer cannot run as a media task.');
	}
	const response = await request(baseUrl, '/v1/ai/audio/transcriptions', {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ offerId: offer.id, audioBase64: input.audioBase64, language: input.language }),
		signal: opts.signal
	});
	let body: { text?: unknown };
	try { body = (await response.json()) as { text?: unknown }; }
	catch { throw new AiCredentialsError('AI_ERROR', 'The monitor returned a non-JSON response.'); }
	if (typeof body.text !== 'string' || !body.text.trim()) {
		throw new AiCredentialsError('AI_ERROR', 'The monitor returned no transcript text.');
	}
	return { text: body.text.trim() };
}
