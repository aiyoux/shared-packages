/** Stable UI error codes for AI connection profiles (never include key material). */

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
 * Network TypeErrors must read as the CORS case users actually hit.
 */
export function formatAiErrorMessage(e: unknown): string {
	if (e instanceof Error && e.message?.trim()) return e.message.trim();
	if (e && typeof e === 'object') {
		const any = e as { message?: string; code?: string; name?: string };
		const parts = [any.message?.trim(), any.code, any.name].filter(Boolean);
		if (parts.length) return parts.join(' · ');
	}
	const s = String(e ?? '').trim();
	return s || 'AI connection failed.';
}