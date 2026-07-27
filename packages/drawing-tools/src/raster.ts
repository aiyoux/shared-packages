import type { PathData } from './types';

/**
 * Canvas rasterizer for committed strokes. The vector PathData stays the source
 * of truth (for editing and SVG export); this paints those same paths into a
 * bitmap so the live DOM doesn't carry thousands of <path> nodes.
 *
 * Path2D understands SVG path `d` strings directly, so a PathData renders on
 * canvas with the same geometry it has in SVG. blendMode 'multiply' maps to the
 * canvas composite op of the same name, which is what makes pencil/marker build
 * up darkness where strokes overlap.
 */

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

const TRANSLATE_RE = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/;
const SCALE_RE = /scale\(\s*(-?[\d.]+)(?:[ ,]+(-?[\d.]+))?\s*\)/;

// Path2D cache: parsing an SVG path `d` string into a Path2D is the dominant cost
// of a full layer redraw (erase/undo/load), and the same PathData objects are
// repainted repeatedly. WeakMap keyed on the PathData object, invalidated when d
// or transform changes (node edits mutate d in place). Falls away with the path.
const path2DCache = new WeakMap<PathData, { key: string; path2d: Path2D }>();
function getPath2D(p: PathData): Path2D {
	const key = `${p.d}|${p.transform ?? ''}`;
	const cached = path2DCache.get(p);
	if (cached && cached.key === key) return cached.path2d;
	const path2d = new Path2D(p.d);
	path2DCache.set(p, { key, path2d });
	return path2d;
}

function applyTransform(ctx: CanvasRenderingContext2D, transform?: string) {
	if (!transform) return;
	const t = TRANSLATE_RE.exec(transform);
	if (t) ctx.translate(parseFloat(t[1]), parseFloat(t[2]));
	const s = SCALE_RE.exec(transform);
	if (s) ctx.scale(parseFloat(s[1]), parseFloat(s[2] ?? s[1]));
}

/** Paint a single path onto the context, honoring fill/stroke/opacity/blend/transform. */
export function drawPath(ctx: CanvasRenderingContext2D, p: PathData) {
	const path = getPath2D(p);
	ctx.save();
	ctx.globalAlpha = p.opacity ?? 1;
	ctx.globalCompositeOperation =
		p.blendMode && p.blendMode !== 'normal'
			? (p.blendMode as GlobalCompositeOperation)
			: 'source-over';
	applyTransform(ctx, p.transform);
	if (p.fill && p.fill !== 'none') {
		ctx.fillStyle = p.fill;
		ctx.fill(path, (p.fillRule as CanvasFillRule) || 'nonzero');
	}
	if (p.stroke && p.stroke !== 'none' && p.strokeWidth) {
		ctx.strokeStyle = p.stroke;
		ctx.lineWidth = p.strokeWidth;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.stroke(path);
	}
	ctx.restore();
}

/** Paint paths in order (z-order matters for blend modes). */
export function drawPaths(ctx: CanvasRenderingContext2D, paths: PathData[]) {
	for (const p of paths) drawPath(ctx, p);
}

/**
 * Approximate bounding box of a path in its own coordinate space, derived from
 * the numeric coordinates in `d` (paths here are mostly M/L polylines, so this
 * is tight; for curves it's a loose but safe superset). Includes half the stroke
 * width as margin, plus any translate() from the transform.
 */
export function pathBounds(p: PathData): Rect | null {
	const d = p.d;
	const len = d.length;
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	let numCount = 0;
	let i = 0;

	while (i < len) {
		const ch = d.charCodeAt(i);
		// Start of a number: digit, minus sign, or decimal point
		if ((ch >= 48 && ch <= 57) || ch === 45 || ch === 46) {
			const start = i;
			if (ch === 45) i++;
			while (i < len && d.charCodeAt(i) >= 48 && d.charCodeAt(i) <= 57) i++;
			if (i < len && d.charCodeAt(i) === 46) {
				i++;
				while (i < len && d.charCodeAt(i) >= 48 && d.charCodeAt(i) <= 57) i++;
			}
			if (i < len && (d.charCodeAt(i) === 101 || d.charCodeAt(i) === 69)) {
				i++;
				if (i < len && (d.charCodeAt(i) === 45 || d.charCodeAt(i) === 43)) i++;
				while (i < len && d.charCodeAt(i) >= 48 && d.charCodeAt(i) <= 57) i++;
			}
			const val = parseFloat(d.substring(start, i));
			if (numCount & 1) {
				if (val < minY) minY = val;
				if (val > maxY) maxY = val;
			} else {
				if (val < minX) minX = val;
				if (val > maxX) maxX = val;
			}
			numCount++;
		} else {
			i++;
		}
	}

	if (numCount < 2 || !Number.isFinite(minX)) return null;
	let tx = 0, ty = 0;
	if (p.transform) {
		const t = TRANSLATE_RE.exec(p.transform);
		if (t) { tx = parseFloat(t[1]); ty = parseFloat(t[2]); }
	}
	const margin = (p.strokeWidth || 0) / 2 + 1;
	return {
		x: minX + tx - margin,
		y: minY + ty - margin,
		width: maxX - minX + margin * 2,
		height: maxY - minY + margin * 2
	};
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
	return (
		a.x < b.x + b.width &&
		a.x + a.width > b.x &&
		a.y < b.y + b.height &&
		a.y + a.height > b.y
	);
}

// Shared path-bounds cache (WeakMap keyed on the PathData object, invalidated
// when d/transform change). Used both by the raster dirty-rect repaint and by
// the erase spatial grid, so a path's bbox is parsed once and reused everywhere
// — including warming bboxes during the incremental pathsByLayer pass so the
// erase grid build at erase-pointerdown is all cache hits (no upfront hitch).
const pathBoundsCache = new WeakMap<PathData, { key: string; bounds: Rect | null }>();
export function cachedPathBounds(p: PathData): Rect | null {
	const key = `${p.d}|${p.transform ?? ''}`;
	const cached = pathBoundsCache.get(p);
	if (cached && cached.key === key) return cached.bounds;
	const bounds = pathBounds(p);
	pathBoundsCache.set(p, { key, bounds });
	return bounds;
}

/** Smallest rect covering both inputs (for accumulating a dirty region). */
export function unionRect(a: Rect | null, b: Rect): Rect {
	if (!a) return b;
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {
		x,
		y,
		width: Math.max(a.x + a.width, b.x + b.width) - x,
		height: Math.max(a.y + a.height, b.y + b.height) - y
	};
}

/**
 * Spatial hash broadphase for `splitPathsByEraser`, keyed on `PathData.id` (a
 * string) rather than object identity. This is the critical difference from the
 * earlier reverted grid: under Svelte 5 deep reactivity, split pieces get a fresh
 * proxy each time `this.paths` is reassigned, so object-identity keys broke and
 * pieces stopped being re-erasable on move 2+. A stable string id is unaffected by
 * proxy wrapping (reading `p.id` through a proxy returns the underlying string),
 * so the grid's id<->cell maps stay consistent across reassignments. Pieces get a
 * fresh id at creation; originals get an id at draw time or on load.
 *
 * Built once per erase drag (O(N) upfront — the cost the user accepts in exchange
 * for O(near)/move), then patched each move via the `splitPathsByEraser` sync opts
 * (removed originals dropped, added pieces inserted). Query returns the set of
 * path ids whose cached bounds intersect the dirty rect.
 */
export class PathBboxGrid {
	private cellSize: number;
	private cells = new Map<string, Set<string>>();   // cellKey -> path ids
	private pathCells = new Map<string, string[]>();  // path id -> cell keys
	private pathBounds = new Map<string, Rect>();      // path id -> cached bounds

	constructor(cellSize = 128) {
		this.cellSize = cellSize;
	}

	insert(p: PathData): void {
		const id = p.id;
		if (!id || this.pathCells.has(id)) return;
		const b = cachedPathBounds(p);
		if (!b) return;
		this.pathBounds.set(id, b);
		const x0 = Math.floor(b.x / this.cellSize);
		const y0 = Math.floor(b.y / this.cellSize);
		const x1 = Math.floor((b.x + b.width) / this.cellSize);
		const y1 = Math.floor((b.y + b.height) / this.cellSize);
		const keys: string[] = [];
		for (let cx = x0; cx <= x1; cx++) {
			for (let cy = y0; cy <= y1; cy++) {
				const k = `${cx},${cy}`;
				let set = this.cells.get(k);
				if (!set) { set = new Set(); this.cells.set(k, set); }
				set.add(id);
				keys.push(k);
			}
		}
		this.pathCells.set(id, keys);
	}

	remove(p: PathData): void {
		const id = p.id;
		if (!id) return;
		const keys = this.pathCells.get(id);
		if (!keys) return;
		for (const k of keys) {
			const set = this.cells.get(k);
			if (set) { set.delete(id); if (set.size === 0) this.cells.delete(k); }
		}
		this.pathCells.delete(id);
		this.pathBounds.delete(id);
	}

	/** Path ids whose cached bounds intersect `rect` (broadphase by cell, then exact). */
	query(rect: Rect): Set<string> {
		const out = new Set<string>();
		const x0 = Math.floor(rect.x / this.cellSize);
		const y0 = Math.floor(rect.y / this.cellSize);
		const x1 = Math.floor((rect.x + rect.width) / this.cellSize);
		const y1 = Math.floor((rect.y + rect.height) / this.cellSize);
		for (let cx = x0; cx <= x1; cx++) {
			for (let cy = y0; cy <= y1; cy++) {
				const set = this.cells.get(`${cx},${cy}`);
				if (!set) continue;
				for (const id of set) {
					const b = this.pathBounds.get(id);
					if (b && rectsIntersect(b, rect)) out.add(id);
				}
			}
		}
		return out;
	}

	get size(): number {
		return this.pathCells.size;
	}
}

/**
 * Redraw only a dirty region: clear that rect, then repaint just the paths whose
 * bounds intersect it (in order). Far cheaper than repainting the whole layer
 * for an edit/erase/delete. Pass cached bounds to avoid recomputing.
 */
export function redrawRegion(
	ctx: CanvasRenderingContext2D,
	paths: PathData[],
	region: Rect,
	boundsOf: (p: PathData, i: number) => Rect | null = pathBounds
) {
	ctx.save();
	ctx.beginPath();
	ctx.rect(region.x, region.y, region.width, region.height);
	ctx.clip();
	ctx.clearRect(region.x, region.y, region.width, region.height);
	for (let i = 0; i < paths.length; i++) {
		const b = boundsOf(paths[i], i);
		if (!b || rectsIntersect(b, region)) drawPath(ctx, paths[i]);
	}
	ctx.restore();
}
