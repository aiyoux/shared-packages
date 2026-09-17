/**
 * Selection highlight as one SVG outline: only the first and last lines of the
 * whole selection clip to the selected glyphs (last line stops after the last
 * character). Mid-selection short/wrapped lines stay full block width so the
 * right edge does not punch in. Bridged across paragraph gaps, then rounded
 * with the calendar month-outline walk (`round_polygon_svg`).
 */
import {
	documentOrder,
	findBlock,
	isAtomic,
	isUnknownBlock,
	plaintextOf,
	type Block,
	type KbPage,
	type Range
} from '@shared-packages/doc-model';
import { isCollapsed, orderedRange } from './range.js';
import { BLOCK_ID_ATTR } from './project.js';
import { lineBoxesOf, type LineBox } from './selection.js';

export type Slab = { top: number; bottom: number; left: number; right: number };

export const SELECTION_ROUND_PX = 3;

const EPS = 0.001;

export type ClipLineOpts = {
	/** Block content box; unclipped edges use this so mid-lines stay full width. */
	full?: { left: number; right: number };
	/** Clip left to the first selected glyph (first line of the whole selection). */
	clipLeft?: boolean;
	/** Clip right to the last selected glyph (last line of the whole selection only). */
	clipRight?: boolean;
};

function glyphEdge(line: LineBox, from: number, to: number): { left: number; right: number } | null {
	const glyphs = (line.glyphs ?? []).filter((g) => g.offset >= from && g.offset < to);
	if (glyphs.length > 0) {
		return {
			left: Math.min(...glyphs.map((g) => g.left)),
			right: Math.max(...glyphs.map((g) => g.right))
		};
	}
	const span = Math.max(1, line.endOffset - line.startOffset);
	const t0 = (from - line.startOffset) / span;
	const t1 = (to - line.startOffset) / span;
	const w = line.right - line.left;
	return { left: line.left + w * t0, right: line.left + w * t1 };
}

export function clipLineToOffsets(
	line: LineBox,
	from: number,
	to: number,
	opts: ClipLineOpts = {}
): Slab | null {
	const a = Math.max(from, line.startOffset);
	const b = Math.min(to, line.endOffset);
	if (a > b) return null;
	if (a === b) {
		if (line.startOffset === line.endOffset && from <= line.startOffset && to >= line.endOffset) {
			const fullLeft = opts.full?.left ?? line.left;
			const fullRight = opts.full?.right ?? line.right;
			return { top: line.top, bottom: line.bottom, left: fullLeft, right: fullRight };
		}
		return null;
	}
	const fullLeft = opts.full?.left ?? line.left;
	const fullRight = opts.full?.right ?? line.right;
	const clipLeft = opts.clipLeft ?? true;
	const clipRight = opts.clipRight ?? true;
	const edges = glyphEdge(line, a, b);
	return {
		top: line.top,
		bottom: line.bottom,
		left: clipLeft && edges ? edges.left : fullLeft,
		right: clipRight && edges ? edges.right : fullRight
	};
}

function sameLine(a: Slab, b: Slab): boolean {
	const mid = (a.top + a.bottom) / 2;
	return mid >= b.top - EPS && mid <= b.bottom + EPS;
}

export function mergeLineRects(slabs: Slab[]): Slab[] {
	if (slabs.length === 0) return [];
	const sorted = [...slabs].sort((a, b) => a.top - b.top || a.left - b.left);
	const out: Slab[] = [];
	for (const s of sorted) {
		const last = out[out.length - 1];
		if (last && sameLine(last, s)) {
			last.left = Math.min(last.left, s.left);
			last.right = Math.max(last.right, s.right);
			last.top = Math.min(last.top, s.top);
			last.bottom = Math.max(last.bottom, s.bottom);
		} else {
			out.push({ ...s });
		}
	}
	return out;
}

/** Fill the vertical gap between consecutive line slabs so the highlight reads as one block. */
export function bridgeGaps(slabs: Slab[]): Slab[] {
	if (slabs.length < 2) return slabs;
	const sorted = [...slabs].sort((a, b) => a.top - b.top || a.left - b.left);
	const out: Slab[] = [{ ...sorted[0]! }];
	for (let i = 1; i < sorted.length; i++) {
		const prev = out[out.length - 1]!;
		const next = sorted[i]!;
		if (next.top > prev.bottom + 0.5) {
			out.push({
				top: prev.bottom,
				bottom: next.top,
				left: Math.min(prev.left, next.left),
				right: Math.max(prev.right, next.right)
			});
		}
		out.push({ ...next });
	}
	return out;
}

/**
 * Clockwise outline of stacked slabs, stepping horizontally where widths
 * differ — the calendar month-outline walk. Inner corners are concave.
 */
export function polygonFromSlabs(slabs: Slab[]): Array<[number, number]> {
	if (slabs.length === 0) return [];
	const rows = slabs.filter((s) => s.right - s.left > EPS && s.bottom - s.top > EPS);
	if (rows.length === 0) return [];
	const first = rows[0]!;
	const last = rows[rows.length - 1]!;
	const points: Array<[number, number]> = [
		[first.left, first.top],
		[first.right, first.top]
	];
	for (let i = 0; i < rows.length; i++) {
		const s = rows[i]!;
		if (i > 0) {
			const prev = rows[i - 1]!;
			if (Math.abs(prev.right - s.right) > EPS) {
				points.push([prev.right, s.top]);
				points.push([s.right, s.top]);
			}
		}
		points.push([s.right, s.bottom]);
	}
	points.push([last.left, last.bottom]);
	for (let i = rows.length - 1; i >= 0; i--) {
		const s = rows[i]!;
		if (i < rows.length - 1) {
			const below = rows[i + 1]!;
			if (Math.abs(below.left - s.left) > EPS) {
				points.push([below.left, s.bottom]);
				points.push([s.left, s.bottom]);
			}
		}
		points.push([s.left, s.top]);
	}
	dedupPolygon(points);
	return points;
}

/** Same as calendar / `@shared-packages/ui` svg-utils.dedup_polygon. */
export function dedupPolygon(points: Array<[number, number]>): void {
	for (let i = points.length - 1; i > 0; i--) {
		const a = points[i]!;
		const b = points[i - 1]!;
		if (Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS) points.splice(i, 1);
	}
	if (points.length >= 2) {
		const first = points[0]!;
		const last = points[points.length - 1]!;
		if (Math.abs(first[0] - last[0]) < EPS && Math.abs(first[1] - last[1]) < EPS) points.pop();
	}
	let changed = true;
	while (changed && points.length >= 3) {
		changed = false;
		const n = points.length;
		for (let i = 0; i < n; i++) {
			const prev = points[(i + n - 1) % n]!;
			const curr = points[i]!;
			const next = points[(i + 1) % n]!;
			const collinearVert =
				Math.abs(prev[0] - curr[0]) <= EPS && Math.abs(curr[0] - next[0]) <= EPS;
			const collinearHorz =
				Math.abs(prev[1] - curr[1]) <= EPS && Math.abs(curr[1] - next[1]) <= EPS;
			if (collinearVert || collinearHorz) {
				points.splice(i, 1);
				changed = true;
				break;
			}
		}
	}
}

/** Same as calendar / `@shared-packages/ui` svg-utils.round_polygon_svg. */
export function roundPolygonSvg(points: Array<[number, number]>, radius: number): string {
	if (points.length < 3 || radius <= EPS) {
		let d = '';
		for (let i = 0; i < points.length; i++) {
			const [x, y] = points[i]!;
			d += i === 0 ? `M ${x.toFixed(3)} ${y.toFixed(3)}` : ` L ${x.toFixed(3)} ${y.toFixed(3)}`;
		}
		return d + ' Z';
	}
	const n = points.length;
	const edgeLen: number[] = [];
	const edgeUnit: Array<[number, number]> = [];
	for (let i = 0; i < n; i++) {
		const [x0, y0] = points[i]!;
		const [x1, y1] = points[(i + 1) % n]!;
		const dx = x1 - x0;
		const dy = y1 - y0;
		const len = Math.hypot(dx, dy);
		edgeLen.push(len);
		edgeUnit.push(len > EPS ? [dx / len, dy / len] : [0, 0]);
	}
	const t: number[] = [];
	for (let i = 0; i < n; i++) {
		const ti = Math.min(radius, edgeLen[(i + n - 1) % n]! / 2, edgeLen[i]! / 2);
		t.push(ti > EPS ? ti : 0);
	}
	for (let i = 0; i < n; i++) {
		const l = edgeLen[i]!;
		if (l <= EPS) {
			t[i] = 0;
			t[(i + 1) % n] = 0;
			continue;
		}
		const sum = t[i]! + t[(i + 1) % n]!;
		if (sum > l) {
			const s = l / sum;
			t[i]! *= s;
			t[(i + 1) % n]! *= s;
		}
	}
	let d = '';
	let started = false;
	for (let i = 0; i < n; i++) {
		const [cx, cy] = points[i]!;
		const [uInX, uInY] = edgeUnit[(i + n - 1) % n]!;
		const [uOutX, uOutY] = edgeUnit[i]!;
		const ti = t[i]!;
		if (
			ti <= EPS ||
			(Math.abs(uInX) <= EPS && Math.abs(uInY) <= EPS) ||
			(Math.abs(uOutX) <= EPS && Math.abs(uOutY) <= EPS)
		) {
			d += started ? ` L ${cx.toFixed(3)} ${cy.toFixed(3)}` : `M ${cx.toFixed(3)} ${cy.toFixed(3)}`;
			started = true;
			continue;
		}
		const pInX = cx - uInX * ti;
		const pInY = cy - uInY * ti;
		const pOutX = cx + uOutX * ti;
		const pOutY = cy + uOutY * ti;
		d += started
			? ` L ${pInX.toFixed(3)} ${pInY.toFixed(3)}`
			: `M ${pInX.toFixed(3)} ${pInY.toFixed(3)}`;
		started = true;
		const cross = uInX * uOutY - uInY * uOutX;
		if (Math.abs(cross) <= EPS) {
			d += ` L ${pOutX.toFixed(3)} ${pOutY.toFixed(3)}`;
			continue;
		}
		const sweep = cross > 0 ? 1 : 0;
		d += ` A ${ti.toFixed(3)} ${ti.toFixed(3)} 0 0 ${sweep} ${pOutX.toFixed(3)} ${pOutY.toFixed(3)}`;
	}
	return d + ' Z';
}

function cssEscape(value: string): string {
	if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
	return value.replace(/"/g, '\\"');
}

function toLocal(slab: Slab, origin: DOMRect): Slab {
	return {
		top: slab.top - origin.top,
		bottom: slab.bottom - origin.top,
		left: slab.left - origin.left,
		right: slab.right - origin.left
	};
}

function blockSlabs(
	el: HTMLElement,
	block: Block,
	from: number,
	to: number,
	isStartBlock: boolean,
	isEndBlock: boolean
): Slab[] {
	const box = el.getBoundingClientRect();
	const full = { left: box.left, right: box.right };
	const lines = lineBoxesOf(el);
	if (lines.length === 0) {
		if (from === 0 && to === plaintextOf(block).length) {
			if (box.width > 0 && box.height > 0) {
				return [{ top: box.top, bottom: box.bottom, left: box.left, right: box.right }];
			}
		}
		return [];
	}
	const hit = lines.filter((line) => {
		const a = Math.max(from, line.startOffset);
		const b = Math.min(to, line.endOffset);
		return a < b || (a === b && line.startOffset === line.endOffset);
	});
	if (hit.length === 0) return [];
	const first = hit[0]!;
	const last = hit[hit.length - 1]!;
	const out: Slab[] = [];
	for (const line of hit) {
		const clipped = clipLineToOffsets(line, from, to, {
			full,
			clipLeft: isStartBlock && line === first,
			clipRight: isEndBlock && line === last
		});
		if (clipped) out.push(clipped);
	}
	return out;
}

export function selectionSlabs(host: HTMLElement, page: KbPage, selection: Range): Slab[] {
	if (isCollapsed(selection)) return [];
	const { start, end } = orderedRange(page, selection);
	const order = documentOrder(page);
	const si = order.findIndex((b) => b.id === start.blockId);
	const ei = order.findIndex((b) => b.id === end.blockId);
	if (si < 0) return [];
	const origin = host.getBoundingClientRect();
	const raw: Slab[] = [];
	for (const block of order.slice(si, (ei < 0 ? si : ei) + 1)) {
		const el = host.querySelector(`[${BLOCK_ID_ATTR}="${cssEscape(block.id)}"]`);
		if (!(el instanceof HTMLElement)) continue;
		if (isAtomic(block) || isUnknownBlock(block)) {
			const r = el.getBoundingClientRect();
			if (r.width > 0 && r.height > 0) {
				raw.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
			}
			continue;
		}
		const from = block.id === start.blockId ? start.offset : 0;
		const to = block.id === end.blockId ? end.offset : plaintextOf(block).length;
		raw.push(
			...blockSlabs(el, block, from, to, block.id === start.blockId, block.id === end.blockId)
		);
	}
	return bridgeGaps(mergeLineRects(raw.map((s) => toLocal(s, origin))));
}

export function selectionOutlinePath(slabs: Slab[], radius = SELECTION_ROUND_PX): string {
	const points = polygonFromSlabs(slabs);
	if (points.length < 3) return '';
	return roundPolygonSvg(points, radius);
}

export function paintSelectionOutline(
	host: HTMLElement,
	svg: SVGSVGElement,
	page: KbPage,
	selection: Range
): void {
	while (svg.firstChild) svg.removeChild(svg.firstChild);
	const w = Math.max(host.offsetWidth, 1);
	const h = Math.max(host.offsetHeight, 1);
	svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
	svg.setAttribute('width', String(w));
	svg.setAttribute('height', String(h));
	if (isCollapsed(selection)) {
		host.removeAttribute('data-kb-sel-svg');
		return;
	}
	const d = selectionOutlinePath(selectionSlabs(host, page, selection));
	if (!d) {
		host.removeAttribute('data-kb-sel-svg');
		return;
	}
	const path = host.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', d);
	svg.appendChild(path);
	host.setAttribute('data-kb-sel-svg', '');
}
