/**
 * AI types for the monitor-routed AI feature.
 *
 * Keys never live in the browser: AI upstream profiles (with their keys) are
 * held by the monitor daemon (`/v1/ai/**`), and the browser sends keyless
 * requests through its monitor connection. The only secret-adjacent value
 * that crosses the wire is a `keyFingerprint` (`"a1b2…9f3c"`).
 * @see monitor docs/design/ai-feature.md
 */

export const HUB_AI_DB_NAME = 'HubAi';
export const HUB_AI_STORE = 'selection';
export const HUB_AI_META = 'meta';
/** Same channel name as the retired profile store (pre-release, free rename). */
export const HUB_AI_SELECTION_CHANNEL = 'hub-ai-profiles';

/** One model entry from `GET /v1/ai/models`. */
export type AiModelEntry = {
	/** Model id sent as `model` in chat completions (e.g. `gpt-4o`). */
	id: string;
	/** Daemon profile id that serves this model. */
	profile: string;
	/** Display name of that profile. */
	profileName: string;
	/** True when that profile is the daemon's default. */
	defaultProfile: boolean;
};

/** Aggregated `GET /v1/ai/models` result: partial success is normal. */
export type AiModelListResult = {
	models: AiModelEntry[];
	errors: Array<{ profile: string; code: string; message: string }>;
};

/** Wire summary of a monitor-held AI profile. Never carries the key. */
export type AiProfileSummary = {
	id: string;
	name: string;
	/** OpenAI-compatible upstream base URL. */
	baseUrl: string;
	default: boolean;
	/** `config` = daemon config row (immutable); `managed` = UI-installed. */
	source: 'config' | 'managed';
	/** `null` when the profile has no key (keyless local upstream). */
	keyFingerprint: string | null;
};

export type AiProfileListResult = {
	profiles: AiProfileSummary[];
	defaultProfile: string | null;
};

/** Body for installing/updating a monitor-held profile. Key is write-only. */
export type AiInstallProfileInput = {
	name: string;
	baseUrl: string;
	/** Required on install; on update, empty/absent keeps the existing key. */
	apiKey: string;
	default?: boolean;
	/** Optional stable id; the daemon generates one when omitted. */
	id?: string;
};

/** OpenAI-compatible chat request, routed through the monitor. */
export type AiChatRequest = {
	model: string;
	messages: Array<{
		role: 'system' | 'user' | 'assistant';
		content:
			| string
			| Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
	}>;
	max_tokens?: number;
	stream?: boolean;
};

/** OpenAI-compatible chat completion response (trimmed to what we read). */
export type AiChatResponse = {
	choices?: Array<{ message?: { content?: string } }>;
};

/**
 * App-side selection: which monitor to use, which daemon profile, which
 * model. No secrets and no provider URLs — those live daemon-side.
 */
export type AiMonitorSelectionV2 = {
	v: 2;
	id: 'active';
	/** null = follow the active monitor profile in HubMonitor. */
	monitorProfileId: string | null;
	/** null = let the daemon route (default profile). */
	aiProfileId: string | null;
	/** Model id sent as `model`. */
	model: string;
	updatedAt: number;
};

/**
 * Normalize a pasted upstream base URL: trim, strip a full-endpoint
 * `/chat/completions` suffix (users paste it constantly), strip trailing `/`.
 */
export function normalizeAiBaseUrl(raw?: string | null): string {
	let t = (raw ?? '').trim();
	if (!t) return '';
	t = t.replace(/\/chat\/completions\/?$/i, '');
	t = t.replace(/\/+$/, '');
	return t;
}

/** Validate install/update fields; returns an English message or null. */
export function validateAiProfileInput(input: {
	name: string;
	baseUrl: string;
	apiKey: string;
	/** When false, empty apiKey is allowed (keep existing). Default true. */
	requireApiKey?: boolean;
}): string | null {
	if (!input.name.trim()) return 'Name is required';
	const baseUrl = normalizeAiBaseUrl(input.baseUrl);
	if (!baseUrl) return 'Base URL is required';
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return 'Base URL is invalid';
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return 'Base URL must be http or https';
	}
	if (url.username || url.password) {
		return 'Base URL must not include credentials';
	}
	if (input.requireApiKey !== false && !input.apiKey.trim()) {
		return 'API key is required';
	}
	return null;
}

export function hostOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return 'the AI server';
	}
}