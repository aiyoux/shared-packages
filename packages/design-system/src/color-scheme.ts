/**
 * Light / dark color scheme for hosts.
 *
 * Studio dark is the default. Hosts persist the choice under
 * `COLOR_SCHEME_STORAGE_KEY` and apply it with `applyColorScheme` on `<html>`.
 * CSS lives in `themes.css` (`:root[data-color-scheme=light]`). Do not follow
 * `prefers-color-scheme` — an unset store is always dark.
 */

export const COLOR_SCHEMES = ['dark', 'light'] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

export const DEFAULT_COLOR_SCHEME: ColorScheme = 'dark';
export const COLOR_SCHEME_STORAGE_KEY = 'scratchpad-color-scheme';

/** Browser chrome / PWA `theme-color` — keep in lockstep with `--theme-color`. */
export const THEME_COLOR: Record<ColorScheme, string> = {
	dark: '#020617',
	light: '#f4f6f8'
};

export function isColorScheme(value: unknown): value is ColorScheme {
	return value === 'dark' || value === 'light';
}

export function readStoredColorScheme(
	storage: Pick<Storage, 'getItem'> | null | undefined =
		typeof localStorage === 'undefined' ? null : localStorage
): ColorScheme {
	try {
		const stored = storage?.getItem(COLOR_SCHEME_STORAGE_KEY);
		if (isColorScheme(stored)) return stored;
	} catch {
		/* private mode / denied */
	}
	return DEFAULT_COLOR_SCHEME;
}

export function persistColorScheme(
	scheme: ColorScheme,
	storage: Pick<Storage, 'setItem'> | null | undefined =
		typeof localStorage === 'undefined' ? null : localStorage
): void {
	try {
		storage?.setItem(COLOR_SCHEME_STORAGE_KEY, scheme);
	} catch {
		/* private mode / denied */
	}
}

/**
 * Write scheme onto a root element (typically `document.documentElement`).
 * Sets `data-color-scheme`, `.dark` / `.light`, `style.colorScheme`, and
 * `<meta name="theme-color">` when present. Does not persist.
 */
export function applyColorScheme(scheme: ColorScheme, root?: HTMLElement): void {
	const el =
		root ?? (typeof document === 'undefined' ? undefined : document.documentElement);
	if (!el) return;
	el.dataset.colorScheme = scheme;
	el.classList.toggle('dark', scheme === 'dark');
	el.classList.toggle('light', scheme === 'light');
	el.style.colorScheme = scheme;
	const meta = el.ownerDocument.querySelector('meta[name="theme-color"]');
	if (meta) meta.setAttribute('content', THEME_COLOR[scheme]);
}
