/**
 * Task-oriented AI client: routes to the monitor's `/v1/ai/**` feature.
 *
 * The monitor resolves monitor profile → upstream and holds every API key;
 * these calls are keyless. Resolution order for the monitor itself mirrors
 * the tools feature: the active HubMonitor profile first, then a capability
 * probe (`GET /v1/meta`) — `null` when no reachable monitor serves AI.
 */
import { createMonitorClient } from '../monitor/client.js';
import { getActiveProfileId, listProfiles } from '../monitor/credentials.js';
import type { MonitorConnectionProfileV1 } from '../monitor/types.js';
import { AiCredentialsError, toAiCredentialsError } from './errors.js';
import type {
	AiChatRequest,
	AiChatResponse,
	AiInstallProfileInput,
	AiModelListResult,
	AiProfileListResult,
	AiProfileSummary
} from './types.js';

export type AiCapabilities = {
	chat?: boolean;
	streaming?: boolean;
	profiles?: number;
};

/** A reachable monitor that serves the AI feature. */
export type AiMonitor = {
	baseUrl: string;
	monitorProfileId: string;
	capabilities: AiCapabilities;
};

/**
 * Resolve a monitor that serves `/v1/ai/**`: the active monitor profile,
 * falling back to probing configured profiles in most-recently-updated
 * order. Returns `null` when no monitor is reachable or none has the AI
 * feature (old daemon) — callers show their "no AI backend" state.
 */
export async function resolveAiMonitor(signal?: AbortSignal): Promise<AiMonitor | null> {
	let candidates: MonitorConnectionProfileV1[] = [];
	try {
		const activeId = await getActiveProfileId();
		const all = await listProfiles();
		candidates = activeId
			? [...all.filter((p) => p.id === activeId), ...all.filter((p) => p.id !== activeId)]
			: all;
	} catch {
		return null;
	}
	for (const profile of candidates) {
		try {
			const transport = createMonitorClient({ baseUrl: profile.baseUrl });
			const meta = await transport.meta();
			const caps = (meta.capabilities as { ai?: AiCapabilities } | undefined)?.ai;
			if (caps?.chat) {
				return { baseUrl: profile.baseUrl, monitorProfileId: profile.id, capabilities: caps };
			}
		} catch (e) {
			if (signal?.aborted) throw toAiCredentialsError(e);
			// Unreachable monitor: try the next candidate.
			continue;
		}
	}
	return null;
}

/** Aggregate model listing via the monitor. */
export async function listAiModels(baseUrl: string, signal?: AbortSignal): Promise<AiModelListResult> {
	const transport = createMonitorClient({ baseUrl });
	if (!transport.aiListModels) {
		throw new AiCredentialsError('AI_UNSUPPORTED', 'This monitor does not serve the AI feature.');
	}
	try {
		return await transport.aiListModels();
	} catch (e) {
		throw toAiCredentialsError(e);
	}
}

export async function listAiProfiles(baseUrl: string): Promise<AiProfileListResult> {
	const transport = createMonitorClient({ baseUrl });
	if (!transport.aiListProfiles) {
		throw new AiCredentialsError('AI_UNSUPPORTED', 'This monitor does not serve the AI feature.');
	}
	try {
		return await transport.aiListProfiles();
	} catch (e) {
		throw toAiCredentialsError(e);
	}
}

/** Install a profile on the monitor. The key is sent once and never stored here. */
export async function installAiProfile(
	baseUrl: string,
	input: AiInstallProfileInput
): Promise<AiProfileSummary> {
	const transport = createMonitorClient({ baseUrl });
	if (!transport.aiInstallProfile) {
		throw new AiCredentialsError('AI_UNSUPPORTED', 'This monitor does not serve the AI feature.');
	}
	try {
		return await transport.aiInstallProfile(input);
	} catch (e) {
		throw toAiCredentialsError(e);
	}
}

export async function updateAiProfile(
	baseUrl: string,
	id: string,
	patch: Partial<AiInstallProfileInput>
): Promise<AiProfileSummary> {
	const transport = createMonitorClient({ baseUrl });
	if (!transport.aiUpdateProfile) {
		throw new AiCredentialsError('AI_UNSUPPORTED', 'This monitor does not serve the AI feature.');
	}
	try {
		return await transport.aiUpdateProfile(id, patch);
	} catch (e) {
		throw toAiCredentialsError(e);
	}
}

export async function deleteAiProfile(baseUrl: string, id: string): Promise<void> {
	const transport = createMonitorClient({ baseUrl });
	if (!transport.aiDeleteProfile) {
		throw new AiCredentialsError('AI_UNSUPPORTED', 'This monitor does not serve the AI feature.');
	}
	try {
		return await transport.aiDeleteProfile(id);
	} catch (e) {
		throw toAiCredentialsError(e);
	}
}

/**
 * One non-streaming chat completion via the monitor. Extracts
 * `choices[0].message.content`; throws the stable taxonomy on failure.
 */
export async function aiChatText(
	baseUrl: string,
	req: AiChatRequest,
	opts?: { aiProfileId?: string; signal?: AbortSignal }
): Promise<string> {
	const transport = createMonitorClient({ baseUrl });
	if (!transport.aiChat) {
		throw new AiCredentialsError('AI_UNSUPPORTED', 'This monitor does not serve the AI feature.');
	}
	let res: AiChatResponse;
	try {
		res = await transport.aiChat(req, opts);
	} catch (e) {
		throw toAiCredentialsError(e);
	}
	const content = res.choices?.[0]?.message?.content;
	if (typeof content !== 'string') {
		throw new AiCredentialsError('AI_ERROR', 'The AI response was empty or malformed.');
	}
	return content;
}

/**
 * Raw streaming chat completion (SSE passthrough). Today's consumers read
 * whole completions; this exists so local tooling and future consumers can
 * stream without a new endpoint.
 */
export async function aiChatStream(
	baseUrl: string,
	req: AiChatRequest,
	opts?: { aiProfileId?: string; signal?: AbortSignal }
): Promise<Response> {
	const transport = createMonitorClient({ baseUrl });
	if (!transport.aiChatStream) {
		throw new AiCredentialsError('AI_UNSUPPORTED', 'This monitor does not serve the AI feature.');
	}
	try {
		return await transport.aiChatStream(req, opts);
	} catch (e) {
		throw toAiCredentialsError(e);
	}
}