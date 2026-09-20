/**
 * Hub-only AI connection profile (OpenAI-compatible endpoint).
 * Secret is plaintext in IDB unless the connection vault is enabled or
 * `persistSecret` is false (tab-only).
 * @see scratch-pad docs/design/ai-sketcher-assistant.md
 */

import type { SealedSecret } from '../vault/types.js';

export const HUB_AI_DB_NAME = 'HubAi';
export const HUB_AI_STORE = 'profiles';
export const HUB_AI_META = 'meta';

/** Default OpenAI-compatible base URL. */
export const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1';

export type AiConnectionProfileV1 = {
	/** Schema version */
	v: 1;
	/** Profile id (uuid) */
	id: string;
	/** Display name */
	name: string;
	/**
	 * API base URL the **browser** opens directly. The endpoint must send CORS
	 * headers for this origin. Default https://api.openai.com/v1.
	 * Never put secrets in the URL.
	 */
	baseUrl: string;
	/**
	 * Secret API key — never log.
	 * Empty when sealed, vault-locked, or session-only and this tab has no copy.
	 */
	apiKey: string;
	/** Model id sent as `model` in chat completions (e.g. `gpt-4o`). */
	model: string;
	/** False = keep the key in this tab only (never write it to IndexedDB). Default true. */
	persistSecret?: boolean;
	/** Present when the connection vault has wrapped `apiKey`. */
	sealedApiKey?: SealedSecret;
	createdAt: number;
	updatedAt: number;
};

export type HubAiMeta = {
	activeProfileId: string | null;
};

/**
 * Normalize a pasted base URL: trim, strip a full-endpoint
 * `/chat/completions` suffix (users paste it constantly), strip trailing `/`.
 * Empty input falls back to the default.
 */
export function normalizeAiBaseUrl(raw?: string | null): string {
	let t = (raw ?? '').trim();
	if (!t) return DEFAULT_AI_BASE_URL;
	t = t.replace(/\/chat\/completions\/?$/i, '');
	t = t.replace(/\/+$/, '');
	return t;
}

/** Validate normalized profile fields; returns an English message or null. */
export function validateAiProfileInput(input: {
	name: string;
	baseUrl: string;
	apiKey: string;
	model: string;
	/** When false, empty apiKey is allowed (keep existing). Default true. */
	requireApiKey?: boolean;
}): string | null {
	if (!input.name.trim()) return 'Name is required';
	const baseUrl = normalizeAiBaseUrl(input.baseUrl);
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
	if (!input.model.trim()) return 'Model is required';
	return null;
}