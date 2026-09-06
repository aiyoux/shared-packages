import { newLayoutId } from './tree.js';
import type { LayoutNode, SplitDirection } from './types.js';

export type Rect = { x: number; y: number; w: number; h: number };
export type CombineSide = 'left' | 'right' | 'top' | 'bottom';

export type CombineTarget = {
	side: CombineSide;
	towardId: string;
	/** Resulting rect of the absorbing leaf, in unit space. */
	result: Rect;
	/** True when the neighbor is deleted rather than sliced through. */
	removes: boolean;
};

type Tile = { id: string; rect: Rect };

export const COMBINE_EPS = 1e-4;

export function approx(a: number, b: number, eps = COMBINE_EPS): boolean {
	return Math.abs(a - b) <= eps;
}

export function leafRects(
	node: LayoutNode,
	bounds: Rect = { x: 0, y: 0, w: 1, h: 1 }
): Record<string, Rect> {
	if (node.kind === 'leaf') return { [node.id]: bounds };
	if (node.direction === 'row') {
		const w1 = bounds.w * node.ratio;
		return {
			...leafRects(node.first, { x: bounds.x, y: bounds.y, w: w1, h: bounds.h }),
			...leafRects(node.second, {
				x: bounds.x + w1,
				y: bounds.y,
				w: bounds.w - w1,
				h: bounds.h
			})
		};
	}
	const h1 = bounds.h * node.ratio;
	return {
		...leafRects(node.first, { x: bounds.x, y: bounds.y, w: bounds.w, h: h1 }),
		...leafRects(node.second, {
			x: bounds.x,
			y: bounds.y + h1,
			w: bounds.w,
			h: bounds.h - h1
		})
	};
}

function coversVertically(from: Rect, other: Rect): boolean {
	return other.y <= from.y + COMBINE_EPS && other.y + other.h >= from.y + from.h - COMBINE_EPS;
}

function coversHorizontally(from: Rect, other: Rect): boolean {
	return other.x <= from.x + COMBINE_EPS && other.x + other.w >= from.x + from.w - COMBINE_EPS;
}

export function coveringSide(from: Rect, other: Rect): CombineSide | null {
	const overlapY =
		Math.min(from.y + from.h, other.y + other.h) - Math.max(from.y, other.y);
	const overlapX =
		Math.min(from.x + from.w, other.x + other.w) - Math.max(from.x, other.x);
	if (approx(other.x, from.x + from.w) && overlapY > COMBINE_EPS && coversVertically(from, other)) {
		return 'right';
	}
	if (approx(other.x + other.w, from.x) && overlapY > COMBINE_EPS && coversVertically(from, other)) {
		return 'left';
	}
	if (approx(other.y, from.y + from.h) && overlapX > COMBINE_EPS && coversHorizontally(from, other)) {
		return 'bottom';
	}
	if (approx(other.y + other.h, from.y) && overlapX > COMBINE_EPS && coversHorizontally(from, other)) {
		return 'top';
	}
	return null;
}

export function expandRect(from: Rect, toward: Rect, side: CombineSide): Rect {
	if (side === 'right') return { x: from.x, y: from.y, w: from.w + toward.w, h: from.h };
	if (side === 'left') return { x: toward.x, y: from.y, w: from.w + toward.w, h: from.h };
	if (side === 'bottom') return { x: from.x, y: from.y, w: from.w, h: from.h + toward.h };
	return { x: from.x, y: toward.y, w: from.w, h: from.h + toward.h };
}

export function subtractRect(from: Rect, taken: Rect): Rect[] {
	const out: Rect[] = [];
	if (taken.y > from.y + COMBINE_EPS) {
		out.push({ x: from.x, y: from.y, w: from.w, h: taken.y - from.y });
	}
	if (taken.y + taken.h < from.y + from.h - COMBINE_EPS) {
		out.push({
			x: from.x,
			y: taken.y + taken.h,
			w: from.w,
			h: from.y + from.h - (taken.y + taken.h)
		});
	}
	if (taken.x > from.x + COMBINE_EPS) {
		out.push({ x: from.x, y: taken.y, w: taken.x - from.x, h: taken.h });
	}
	if (taken.x + taken.w < from.x + from.w - COMBINE_EPS) {
		out.push({
			x: taken.x + taken.w,
			y: taken.y,
			w: from.x + from.w - (taken.x + taken.w),
			h: taken.h
		});
	}
	return out.filter((r) => r.w > COMBINE_EPS && r.h > COMBINE_EPS);
}

export function combineTargets(
	root: LayoutNode,
	fromId: string,
	rects = leafRects(root)
): CombineTarget[] {
	const from = rects[fromId];
	if (!from) return [];
	const targets: CombineTarget[] = [];
	for (const [id, rect] of Object.entries(rects)) {
		if (id === fromId) continue;
		const side = coveringSide(from, rect);
		if (!side) continue;
		const result = expandRect(from, rect, side);
		const taken = {
			x: Math.max(from.x, rect.x),
			y: Math.max(from.y, rect.y),
			w: 0,
			h: 0
		};
		if (side === 'left' || side === 'right') {
			taken.x = rect.x;
			taken.y = from.y;
			taken.w = rect.w;
			taken.h = from.h;
		} else {
			taken.x = from.x;
			taken.y = rect.y;
			taken.w = from.w;
			taken.h = rect.h;
		}
		targets.push({
			side,
			towardId: id,
			result,
			removes: subtractRect(rect, taken).length === 0
		});
	}
	return targets;
}

function geometryRatio(value: number): number {
	if (!Number.isFinite(value)) return 0.5;
	return Math.min(0.999, Math.max(0.001, value));
}

function tryCut(
	tiles: Tile[],
	axis: 'x' | 'y'
): { at: number; first: Tile[]; second: Tile[] } | null {
	const start = Math.min(...tiles.map((t) => (axis === 'x' ? t.rect.x : t.rect.y)));
	const end = Math.max(
		...tiles.map((t) => (axis === 'x' ? t.rect.x + t.rect.w : t.rect.y + t.rect.h))
	);
	const raw = tiles.flatMap((t) =>
		axis === 'x' ? [t.rect.x, t.rect.x + t.rect.w] : [t.rect.y, t.rect.y + t.rect.h]
	);
	const candidates = [...new Set(raw.map((n) => Math.round(n * 1e8) / 1e8))]
		.filter((v) => v > start + COMBINE_EPS && v < end - COMBINE_EPS)
		.sort((a, b) => a - b);

	for (const at of candidates) {
		const first: Tile[] = [];
		const second: Tile[] = [];
		let ok = true;
		for (const t of tiles) {
			const a = axis === 'x' ? t.rect.x : t.rect.y;
			const b = a + (axis === 'x' ? t.rect.w : t.rect.h);
			if (b <= at + COMBINE_EPS) first.push(t);
			else if (a >= at - COMBINE_EPS) second.push(t);
			else {
				ok = false;
				break;
			}
		}
		if (ok && first.length && second.length && first.length + second.length === tiles.length) {
			return { at, first, second };
		}
	}
	return null;
}

export function treeFromTiles(tiles: Tile[]): LayoutNode | null {
	if (tiles.length === 0) return null;
	if (tiles.length === 1) return { kind: 'leaf', id: tiles[0]!.id };

	const row = tryCut(tiles, 'x');
	const col = tryCut(tiles, 'y');
	const cut = row ?? col;
	if (!cut) return null;
	const direction: SplitDirection = row ? 'row' : 'col';
	const start = Math.min(
		...tiles.map((t) => (direction === 'row' ? t.rect.x : t.rect.y))
	);
	const end = Math.max(
		...tiles.map((t) =>
			direction === 'row' ? t.rect.x + t.rect.w : t.rect.y + t.rect.h
		)
	);
	const first = treeFromTiles(cut.first);
	const second = treeFromTiles(cut.second);
	if (!first || !second) return null;
	return {
		kind: 'split',
		id: newLayoutId('split'),
		direction,
		ratio: geometryRatio((cut.at - start) / (end - start)),
		first,
		second
	};
}

export function combineLeaves(
	root: LayoutNode,
	fromId: string,
	towardId: string
): { root: LayoutNode; removed: string[]; created: string[] } | null {
	if (fromId === towardId) return null;
	const rects = leafRects(root);
	const from = rects[fromId];
	const toward = rects[towardId];
	if (!from || !toward) return null;
	const side = coveringSide(from, toward);
	if (!side) return null;
	const result = expandRect(from, toward, side);
	const taken: Rect =
		side === 'left' || side === 'right'
			? { x: toward.x, y: from.y, w: toward.w, h: from.h }
			: { x: from.x, y: toward.y, w: from.w, h: toward.h };
	const remainders = subtractRect(toward, taken);
	const created: string[] = [];
	const tiles: Tile[] = [];
	for (const [id, rect] of Object.entries(rects)) {
		if (id === fromId || id === towardId) continue;
		tiles.push({ id, rect });
	}
	tiles.push({ id: fromId, rect: result });
	const removed: string[] = [];
	if (remainders.length === 0) {
		removed.push(towardId);
	} else {
		tiles.push({ id: towardId, rect: remainders[0]! });
		for (let i = 1; i < remainders.length; i++) {
			const id = newLayoutId('leaf');
			created.push(id);
			tiles.push({ id, rect: remainders[i]! });
		}
	}
	const next = treeFromTiles(tiles);
	if (!next) return null;
	return { root: next, removed, created };
}
