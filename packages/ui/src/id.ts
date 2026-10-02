/**
 * Opaque list-item identity for file queues and result lists.
 *
 * These ids key DOM state and in-memory arrays only — they are never
 * persisted and never collide across tabs in any way that matters, so a
 * monotonic-plus-random token is enough and UUIDs would be heavier than
 * the records they name.
 */
export function randomId(prefix = ''): string {
	const head = prefix ? `${prefix}-` : '';
	return `${head}${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}