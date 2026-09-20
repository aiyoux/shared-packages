/**
 * AI connection profiles (OpenAI-compatible chat endpoints).
 * Secret storage follows the B2 pattern (vault seal / tab-only / plaintext);
 * the key is never logged and never put in the URL.
 */
import { AiCredentialsError, formatAiErrorMessage } from './errors.js';
import { normalizeAiBaseUrl, validateAiProfileInput, type AiConnectionProfileV1 } from './types.js';

export {
	closeCredentialsDbForTests,
	deleteProfile,
	getActiveProfileId,
	getProfile,
	listProfiles,
	listStoredProfiles,
	redactProfile,
	rewriteStoredSecret,
	revealApiKey,
	saveProfile,
	setActiveProfileId
} from './credentials.js';
export {
	AiCredentialsError,
	formatAiErrorMessage
} from './errors.js';
export {
	DEFAULT_AI_BASE_URL,
	HUB_AI_DB_NAME,
	HUB_AI_META,
	HUB_AI_STORE,
	normalizeAiBaseUrl,
	validateAiProfileInput,
	type AiConnectionProfileV1,
	type HubAiMeta
} from './types.js';

export function hostOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return 'the AI server';
	}
}

async function envelopeMessage(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as {
			error?: { message?: string; code?: string };
			message?: string;
		};
		const msg = body?.error?.message || body?.message || body?.error?.code || '';
		return msg.trim();
	} catch {
		return '';
	}
}

/**
 * `GET {baseUrl}/models` — doubles as the Test connection probe. Every
 * OpenAI-compatible server ships it; returns sorted model ids.
 */
export async function fetchAvailableModels(
	baseUrl: string,
	apiKey: string,
	signal?: AbortSignal
): Promise<string[]> {
	const url = `${normalizeAiBaseUrl(baseUrl)}/models`;
	let res: Response;
	try {
		res = await fetch(url, {
			method: 'GET',
			headers: apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {},
			signal
		});
	} catch (err) {
		if (err instanceof DOMException && err.name === 'AbortError') throw err;
		// fetch() TypeErrors are CORS rejections or unreachable hosts.
		throw new AiCredentialsError(
			'AI_NETWORK',
			'The AI server does not allow browser requests (CORS), or is unreachable.'
		);
	}
	if (res.status === 401 || res.status === 403) {
		throw new AiCredentialsError('AI_AUTH', `API key rejected by ${hostOf(baseUrl)}.`);
	}
	if (res.status === 404) {
		throw new AiCredentialsError(
			'AI_NOT_FOUND',
			`Models endpoint not found on ${hostOf(baseUrl)} — check the base URL.`
		);
	}
	if (!res.ok) {
		const detail = await envelopeMessage(res);
		throw new AiCredentialsError(
			'AI_ERROR',
			`AI server error (${res.status})${detail ? `: ${detail}` : ''}.`
		);
	}
	const body = (await res.json()) as { data?: Array<{ id?: string }> };
	const ids = (body.data ?? [])
		.map((m) => (typeof m?.id === 'string' ? m.id : ''))
		.filter((id) => id)
		.sort((a, b) => a.localeCompare(b));
	if (ids.length === 0) {
		throw new AiCredentialsError(
			'AI_EMPTY',
			`The server at ${hostOf(baseUrl)} listed no models.`
		);
	}
	return ids;
}

/** Test connection: same call as the model list, reduced to ok/throws. */
export async function testAiConnection(
	baseUrl: string,
	apiKey: string,
	signal?: AbortSignal
): Promise<string[]> {
	try {
		return await fetchAvailableModels(baseUrl, apiKey, signal);
	} catch (err) {
		if (err instanceof DOMException && err.name === 'AbortError') throw err;
		if (err instanceof AiCredentialsError) throw err;
		throw new AiCredentialsError('AI_ERROR', formatAiErrorMessage(err));
	}
}

export { HUB_AI_PROFILES_CHANNEL } from '../crossTab.js';