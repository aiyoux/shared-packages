const BLOCKED = /^(javascript|data|vbscript):/i;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function isIgnorable(code: number): boolean {
	return code <= 32 || code === 127 || (code >= 0x80 && code <= 0x9f) || code === 0xfeff;
}

/** Strip C0 / C1 / whitespace from the scheme prefix so `\0javascript:` cannot pass as relative. */
function normalizeHref(href: string): string {
	let i = 0;
	while (i < href.length && isIgnorable(href.charCodeAt(i))) i++;
	let scheme = '';
	while (i < href.length) {
		const code = href.charCodeAt(i);
		if (href[i] === ':') {
			return scheme + ':' + href.slice(i + 1);
		}
		if (isIgnorable(code)) {
			i++;
			continue;
		}
		scheme += href[i];
		i++;
	}
	return href.trim();
}

/** Allow https, http, absolute `/` paths, and relative page paths. Block javascript/data/vbscript. */
export function allowlistedHref(href: string): string | null {
	const value = normalizeHref(href);
	if (!value) return null;
	if (BLOCKED.test(value)) return null;
	const lower = value.toLowerCase();
	if (lower.startsWith('https:') || lower.startsWith('http:')) return value;
	if (value.startsWith('/')) return value;
	if (SCHEME.test(value)) return null;
	return value;
}

/**
 * Image `src` uses the same scheme block as href, then either an https/http URL
 * (linked image — the host CSP must allow `img-src https:`) or a page-relative
 * `assets/<file>` (cloned image). Return null rather than throw so a bad stored
 * value cannot XSS the host. `data:` stays blocked by `allowlistedHref`.
 */
export function allowlistedSrc(src: string): string | null {
	const value = allowlistedHref(src);
	if (!value) return null;
	if (value.includes('..') || value.includes('\\')) return null;
	if (/^https?:\/\//i.test(value)) return value;
	if (!/^assets\/[^/?#]+$/.test(value)) return null;
	return value;
}
