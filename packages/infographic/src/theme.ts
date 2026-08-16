import type { Theme } from './types.js';

export const DEFAULT_FONT_FAMILY = 'ui-sans-serif, system-ui, sans-serif';
export const DEFAULT_FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export const DEFAULT_PALETTE = ['#2563eb', '#0d9488', '#d97706', '#dc2626', '#7c3aed', '#db2777'];

export function defaultTheme(): Theme {
	return {
		palette: [...DEFAULT_PALETTE],
		background: '#f8fafc',
		surface: '#ffffff',
		text: '#0f172a',
		muted: '#64748b',
		grid: '#e2e8f0',
		fontFamily: DEFAULT_FONT_FAMILY,
		fontMono: DEFAULT_FONT_MONO,
		radius: 8
	};
}

function asString(value: unknown, fallback: string): string {
	return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function mergeTheme(raw: unknown): Theme {
	const fallback = defaultTheme();
	if (!raw || typeof raw !== 'object') return fallback;
	const o = raw as Record<string, unknown>;
	const palette = Array.isArray(o.palette)
		? o.palette.filter((c): c is string => typeof c === 'string' && c.length > 0)
		: fallback.palette;
	return {
		palette: palette.length > 0 ? palette : fallback.palette,
		background: asString(o.background, fallback.background),
		surface: asString(o.surface, fallback.surface),
		text: asString(o.text, fallback.text),
		muted: asString(o.muted, fallback.muted),
		grid: asString(o.grid, fallback.grid),
		fontFamily: asString(o.fontFamily, fallback.fontFamily),
		fontMono: asString(o.fontMono, fallback.fontMono),
		radius: asNumber(o.radius, fallback.radius)
	};
}

/** Palette index, hex literal, or CSS color string. */
export function resolveColorToken(
	theme: Theme,
	token: string | number | undefined,
	fallbackIndex = 0
): string {
	const fallback = theme.palette[fallbackIndex] ?? theme.palette[0] ?? '#2563eb';
	if (typeof token === 'number' && Number.isFinite(token)) {
		const i = Math.abs(Math.trunc(token)) % theme.palette.length;
		return theme.palette[i] ?? fallback;
	}
	if (typeof token === 'string') {
		if (token.startsWith('#')) return token;
		if (token !== '' && Number.isFinite(Number(token))) {
			const i = Math.abs(Math.trunc(Number(token))) % theme.palette.length;
			return theme.palette[i] ?? fallback;
		}
		return token;
	}
	return fallback;
}
