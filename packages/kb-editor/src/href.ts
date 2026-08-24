const BLOCKED = /^(javascript|data|vbscript):/i;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** Allow https, http, absolute `/` paths, and relative page paths. Block javascript/data/vbscript. */
export function allowlistedHref(href: string): string | null {
	const value = href.trim();
	if (!value) return null;
	if (BLOCKED.test(value)) return null;
	const lower = value.toLowerCase();
	if (lower.startsWith('https:') || lower.startsWith('http:')) return value;
	if (value.startsWith('/')) return value;
	if (SCHEME.test(value)) return null;
	return value;
}

export function allowlistedSrc(src: string): string | null {
	return allowlistedHref(src);
}
