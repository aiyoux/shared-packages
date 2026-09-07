/**
 * Font marks carry picker ids and canonical size strings, never raw CSS —
 * rendering maps them through this allowlist the way `href.ts` gates URLs.
 */

const FAMILY_CSS: Record<'sans' | 'serif' | 'mono', string> = {
	sans: 'var(--font-sans)',
	serif: 'Georgia, "Times New Roman", serif',
	mono: 'var(--font-mono)'
};

/** CSS `font-family` for a stored picker id, or null when unknown. */
export function fontFamilyCss(id: string): string | null {
	return id === 'sans' || id === 'serif' || id === 'mono' ? FAMILY_CSS[id] : null;
}