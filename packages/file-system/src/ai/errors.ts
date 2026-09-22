/** Stable UI error codes for the monitor-routed AI client (never include key material). */

export class AiCredentialsError extends Error {
	readonly code: string;
	constructor(code: string, message?: string) {
		super((message && message.trim()) || code);
		this.name = 'AiCredentialsError';
		this.code = code;
	}
}

/**
 * Human-readable text for any thrown value (Test button + chat errors).
 * Network TypeErrors must read as the unreachable-monitor case users hit.
 */
export function formatAiErrorMessage(e: unknown): string {
	if (e instanceof Error && e.message?.trim()) return e.message.trim();
	if (e && typeof e === 'object') {
		const any = e as { message?: string; code?: string; name?: string };
		const parts = [any.message?.trim(), any.code, any.name].filter(Boolean);
		if (parts.length) return parts.join(' · ');
	}
	const s = String(e ?? '').trim();
	return s || 'AI request failed.';
}

/**
 * Map any thrown value — a monitor error envelope (`[ai.*] message` from the
 * transport), a TypeError, an abort — to the stable client taxonomy. Chat
 * callers catch `AiCredentialsError` and switch on `code`.
 */
export function toAiCredentialsError(e: unknown): AiCredentialsError {
	if (e instanceof AiCredentialsError) return e;
	const message = e instanceof Error ? e.message : String(e ?? '');
	// The monitor client prefixes envelope errors with `[code] `.
	const m = /^\[(ai\.[\w.]+)\]\s*(.*)$/.exec(message);
	const code = m?.[1] ?? '';
	const detail = m?.[2] ?? '';
	switch (code) {
		case 'ai.upstream_auth':
			return new AiCredentialsError('AI_AUTH', detail || 'API key rejected by the AI server.');
		case 'ai.upstream_rate_limited':
			return new AiCredentialsError('AI_RATE', detail || 'AI server rate limit hit.');
		case 'ai.profile_not_found':
		case 'ai.upstream_not_found':
			return new AiCredentialsError('AI_NOT_FOUND', detail || 'Unknown AI profile or model.');
		case 'ai.upstream_unreachable':
			return new AiCredentialsError('AI_NETWORK', `AI server unreachable. ${detail}`.trim());
		case 'ai.no_profiles':
			return new AiCredentialsError(
				'AI_NOT_FOUND',
				'No AI profile is installed on the monitor yet.'
			);
		case 'ai.busy':
			return new AiCredentialsError('AI_ERROR', detail || 'Monitor AI is busy; retry shortly.');
	}
	if (code.startsWith('ai.')) {
		return new AiCredentialsError('AI_ERROR', detail || code);
	}
	// Transport failures: abort passes through as AI_ABORTED, fetch
	// TypeErrors are the unreachable-monitor case.
	if (e instanceof DOMException && e.name === 'AbortError') {
		return new AiCredentialsError('AI_ABORTED', 'Request aborted.');
	}
	if (e instanceof TypeError) {
		return new AiCredentialsError(
			'AI_NETWORK',
			'Cannot reach the monitor (network/CORS). Is it running and allowing this origin?'
		);
	}
	return new AiCredentialsError('AI_ERROR', detail || formatAiErrorMessage(e));
}