import type { Mark, PaletteId } from './types.js';

export const PALETTE_IDS = [
	'red',
	'rose',
	'pink',
	'orange',
	'amber',
	'yellow',
	'green',
	'emerald',
	'sky',
	'blue',
	'violet',
	'purple',
	'gray'
] as const satisfies readonly PaletteId[];

const PALETTE_SET: ReadonlySet<string> = new Set(PALETTE_IDS);

/** Paper (Pages / Word / light sheet) hex for each preset. */
export const PALETTE_PAPER_HEX: Record<PaletteId, string> = {
	red: '#ef4444',
	rose: '#f43f5e',
	pink: '#ec4899',
	orange: '#f97316',
	amber: '#f59e0b',
	yellow: '#eab308',
	green: '#22c55e',
	emerald: '#10b981',
	sky: '#0ea5e9',
	blue: '#3b82f6',
	violet: '#8b5cf6',
	purple: '#a855f7',
	gray: '#5c6b7a'
};

/** Extra snap targets for Word / HTML primaries that sit far from --cat-*. */
const SNAP_ALIASES: Record<string, PaletteId> = {
	'#ff0000': 'red',
	'#c00000': 'red',
	'#ffc000': 'amber',
	'#ffff00': 'yellow',
	'#00b050': 'green',
	'#00ff00': 'green',
	'#00b0f0': 'sky',
	'#0070c0': 'blue',
	'#0000ff': 'blue',
	'#7030a0': 'purple',
	'#ff00ff': 'pink',
	'#ff6600': 'orange',
	'#ffa500': 'orange',
	'#808080': 'gray',
	'#666666': 'gray',
	'#6b7280': 'gray'
};

const SNAP_MAX_DIST = 48;

export function isPaletteId(value: unknown): value is PaletteId {
	return typeof value === 'string' && PALETTE_SET.has(value);
}

/** Canonical `#rrggbb`, or null. Accepts `#rgb`, `#rrggbb`, and the same without `#`. */
export function sanitizeHex(raw: string): string | null {
	const s = raw.trim().toLowerCase();
	const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
	if (!m) return null;
	const h = m[1]!;
	if (h.length === 3) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
	return `#${h}`;
}

/** Parse a CSS color used in paste (`#hex` or `rgb()`). Named colors and vars are dropped. */
export function parseCssColor(raw: string): string | null {
	const trimmed = raw.trim();
	const hex = sanitizeHex(trimmed);
	if (hex) return hex;
	const rgb = /^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/i.exec(trimmed);
	if (!rgb) return null;
	const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
	return `#${toHex(Number(rgb[1]))}${toHex(Number(rgb[2]))}${toHex(Number(rgb[3]))}`;
}

function hexRgb(hex: string): [number, number, number] {
	return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function dist(a: string, b: string): number {
	const [ar, ag, ab] = hexRgb(a);
	const [br, bg, bb] = hexRgb(b);
	const dr = ar - br;
	const dg = ag - bg;
	const db = ab - bb;
	return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** Nearest preset id when `hex` is close to a paper swatch (or a known alias). */
export function nearestPaletteId(hex: string): PaletteId | null {
	const canonical = sanitizeHex(hex);
	if (!canonical) return null;
	const alias = SNAP_ALIASES[canonical];
	if (alias) return alias;
	let best: PaletteId | null = null;
	let bestDist = Infinity;
	for (const id of PALETTE_IDS) {
		const d = dist(canonical, PALETTE_PAPER_HEX[id]);
		if (d < bestDist) {
			bestDist = d;
			best = id;
		}
	}
	return best && bestDist <= SNAP_MAX_DIST ? best : null;
}

export type PaintMark = Extract<Mark, { type: 'color' } | { type: 'highlight' }>;

export function paintPalette(mark: PaintMark): PaletteId | null {
	return 'color' in mark ? mark.color : null;
}

export function paintHex(mark: PaintMark): string | null {
	return 'hex' in mark ? mark.hex : null;
}

/** Paper hex for export / a custom input preview of a preset. */
export function paperHexOf(mark: PaintMark): string {
	const id = paintPalette(mark);
	if (id) return PALETTE_PAPER_HEX[id];
	return paintHex(mark) ?? '#000000';
}

function coercePaint<T extends 'color' | 'highlight'>(
	type: T,
	rec: Record<string, unknown>
): Extract<Mark, { type: T }> | null {
	if (isPaletteId(rec.color)) return { type, color: rec.color } as Extract<Mark, { type: T }>;
	const fromHex = typeof rec.hex === 'string' ? sanitizeHex(rec.hex) : null;
	if (fromHex) return { type, hex: fromHex } as Extract<Mark, { type: T }>;
	const fromColor = typeof rec.color === 'string' ? sanitizeHex(rec.color) : null;
	if (fromColor) return { type, hex: fromColor } as Extract<Mark, { type: T }>;
	return null;
}

export function coerceColorMark(raw: unknown): Extract<Mark, { type: 'color' }> | null {
	if (!raw || typeof raw !== 'object') return null;
	const rec = raw as Record<string, unknown>;
	if (rec.type !== 'color') return null;
	return coercePaint('color', rec);
}

export function coerceHighlightMark(raw: unknown): Extract<Mark, { type: 'highlight' }> | null {
	if (!raw || typeof raw !== 'object') return null;
	const rec = raw as Record<string, unknown>;
	if (rec.type !== 'highlight') return null;
	return coercePaint('highlight', rec);
}

/** Map a pasted CSS color onto a color/highlight mark (snap to preset when close). */
export function paintMarkFromCss(type: 'color', raw: string): Extract<Mark, { type: 'color' }> | null;
export function paintMarkFromCss(
	type: 'highlight',
	raw: string
): Extract<Mark, { type: 'highlight' }> | null;
export function paintMarkFromCss(type: 'color' | 'highlight', raw: string): PaintMark | null {
	const hex = parseCssColor(raw);
	if (!hex) return null;
	const id = nearestPaletteId(hex);
	return (id ? { type, color: id } : { type, hex }) as PaintMark;
}
