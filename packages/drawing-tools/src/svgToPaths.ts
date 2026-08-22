/**
 * PDF/SVG → sketch PathData conversion (Editable Vector Strokes import).
 *
 * Pipeline:
 *  1. Parse SVG (often with nested <g transform> and primitives).
 *  2. Expand rect/circle/ellipse/line/polygon/polyline → path `d`.
 *  3. Walk ancestor transforms and compose a single affine matrix
 *     (does NOT rely on getCTM / mounting untrusted SVG in the live DOM).
 *  4. Emit PathData with that matrix (+ optional page-fit matrix).
 *
 * Security: never mounts the full untrusted SVG tree into the document.
 * Only geometry/presentation attributes are read from the parse tree.
 */

import type { PathData } from './types.ts';
import {
	AFFINE_IDENTITY,
	isAffineIdentity,
	multiplyAffine,
	parseSvgTransform,
	type AffineMatrix
} from './parseTransform.ts';

export interface SvgLossyStats {
	clipPaths: number;
	gradients: number;
	images: number;
	useElements: number;
	/** Primitives that could not be converted (malformed / zero-size / etc.). */
	droppedPrimitives: number;
}

export interface SvgToPathsOptions {
	layerId?: string;
	fitTransform?: {
		scale: number;
		translateX: number;
		translateY: number;
	};
}

export interface SvgToPathsResult {
	paths: PathData[];
	stats: SvgLossyStats;
}

const SKIP_ANCESTORS = new Set([
	'defs',
	'clippath',
	'mask',
	'symbol',
	'pattern',
	'marker',
	'lineargradient',
	'radialgradient',
	'filter',
	'style',
	'script',
	'metadata',
	'title',
	'desc'
]);

const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline']);

function emptyStats(): SvgLossyStats {
	return { clipPaths: 0, gradients: 0, images: 0, useElements: 0, droppedPrimitives: 0 };
}

function matrixToAttr(m: AffineMatrix): string {
	const n = (v: number) => {
		if (Object.is(v, -0)) return '0';
		const r = Math.round(v * 1e6) / 1e6;
		return String(r);
	};
	return `matrix(${n(m.a)},${n(m.b)},${n(m.c)},${n(m.d)},${n(m.e)},${n(m.f)})`;
}

/** True if `el` is under defs/clipPath/etc. (not drawable page content). */
function isInSkipSubtree(el: Element, root: Element): boolean {
	let cur: Element | null = el.parentElement;
	while (cur && cur !== root) {
		if (SKIP_ANCESTORS.has(cur.tagName.toLowerCase().replace(/^.*:/, ''))) return true;
		cur = cur.parentElement;
	}
	return false;
}

/**
 * Local CTM for `el` relative to `root` (usually the page <svg>).
 * CTM = T_rootChild * … * T_parent * T_el  (parent applied outermost).
 */
export function composeElementTransform(el: Element, root: Element): AffineMatrix {
	const chain: string[] = [];
	let cur: Element | null = el;
	while (cur && cur !== root) {
		const t = cur.getAttribute('transform');
		if (t?.trim()) chain.push(t);
		cur = cur.parentElement;
	}
	// Also honor transform on the root svg itself (rare but valid).
	if (root.getAttribute) {
		const rt = root.getAttribute('transform');
		if (rt?.trim()) chain.push(rt);
	}

	// chain is [self, parent, …, nearRoot]; multiply root→leaf.
	let m: AffineMatrix = { ...AFFINE_IDENTITY };
	for (let i = chain.length - 1; i >= 0; i--) {
		const tm = parseSvgTransform(chain[i]);
		if (tm) m = multiplyAffine(m, tm);
	}
	return m;
}

function numAttr(el: Element, name: string, fallback = 0): number {
	const v = el.getAttribute(name);
	if (v === null || v === '') return fallback;
	const n = parseFloat(v);
	return Number.isFinite(n) ? n : fallback;
}

/** Parse SVG points="x,y x,y …" into coordinate pairs. */
function parsePoints(points: string | null): { x: number; y: number }[] {
	if (!points?.trim()) return [];
	const nums = points
		.trim()
		.split(/[\s,]+/)
		.map(Number)
		.filter((n) => Number.isFinite(n));
	const out: { x: number; y: number }[] = [];
	for (let i = 0; i + 1 < nums.length; i += 2) {
		out.push({ x: nums[i], y: nums[i + 1] });
	}
	return out;
}

/** Convert a basic SVG shape element to a path `d`, or null if unsupported/empty. */
export function shapeElementToPathD(el: Element): string | null {
	const tag = el.tagName.toLowerCase().replace(/^.*:/, '');

	switch (tag) {
		case 'path': {
			const d = el.getAttribute('d');
			return d && d.trim() ? d.trim() : null;
		}
		case 'rect': {
			const x = numAttr(el, 'x');
			const y = numAttr(el, 'y');
			const w = numAttr(el, 'width');
			const h = numAttr(el, 'height');
			if (w <= 0 || h <= 0) return null;
			let rx = Math.abs(numAttr(el, 'rx', NaN));
			let ry = Math.abs(numAttr(el, 'ry', NaN));
			if (!Number.isFinite(rx) && !Number.isFinite(ry)) {
				// Sharp rect
				return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
			}
			if (!Number.isFinite(rx)) rx = ry;
			if (!Number.isFinite(ry)) ry = rx;
			rx = Math.min(rx, w / 2);
			ry = Math.min(ry, h / 2);
			// Rounded rect via arcs (SVG path approximation of rx/ry).
			return (
				`M ${x + rx} ${y} ` +
				`H ${x + w - rx} ` +
				`A ${rx} ${ry} 0 0 1 ${x + w} ${y + ry} ` +
				`V ${y + h - ry} ` +
				`A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h} ` +
				`H ${x + rx} ` +
				`A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry} ` +
				`V ${y + ry} ` +
				`A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`
			);
		}
		case 'circle': {
			const cx = numAttr(el, 'cx');
			const cy = numAttr(el, 'cy');
			const r = numAttr(el, 'r');
			if (r <= 0) return null;
			// Two semicircles form a full circle.
			return (
				`M ${cx - r} ${cy} ` +
				`A ${r} ${r} 0 1 0 ${cx + r} ${cy} ` +
				`A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`
			);
		}
		case 'ellipse': {
			const cx = numAttr(el, 'cx');
			const cy = numAttr(el, 'cy');
			const rx = numAttr(el, 'rx');
			const ry = numAttr(el, 'ry');
			if (rx <= 0 || ry <= 0) return null;
			return (
				`M ${cx - rx} ${cy} ` +
				`A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} ` +
				`A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`
			);
		}
		case 'line': {
			const x1 = numAttr(el, 'x1');
			const y1 = numAttr(el, 'y1');
			const x2 = numAttr(el, 'x2');
			const y2 = numAttr(el, 'y2');
			return `M ${x1} ${y1} L ${x2} ${y2}`;
		}
		case 'polygon': {
			const pts = parsePoints(el.getAttribute('points'));
			if (pts.length < 2) return null;
			const [first, ...rest] = pts;
			return (
				`M ${first.x} ${first.y} ` +
				rest.map((p) => `L ${p.x} ${p.y}`).join(' ') +
				' Z'
			);
		}
		case 'polyline': {
			const pts = parsePoints(el.getAttribute('points'));
			if (pts.length < 2) return null;
			const [first, ...rest] = pts;
			return `M ${first.x} ${first.y} ` + rest.map((p) => `L ${p.x} ${p.y}`).join(' ');
		}
		default:
			return null;
	}
}

/**
 * Resolve a presentation attribute, walking ancestors for inheritance.
 * Checks the XML attribute and a simple `style="attr: value"` form.
 */
function resolvePresentation(el: Element, attr: string, root: Element): string | null {
	let cur: Element | null = el;
	while (cur) {
		const direct = cur.getAttribute(attr);
		if (direct !== null && direct !== '') return direct.trim();

		const style = cur.getAttribute('style');
		if (style) {
			// Match `stroke: red` or `stroke-width:2` — attr may contain hyphens.
			const re = new RegExp(`(?:^|;)\\s*${attr.replace(/-/g, '\\-')}\\s*:\\s*([^;]+)`, 'i');
			const m = style.match(re);
			if (m) return m[1].trim();
		}

		if (cur === root) break;
		cur = cur.parentElement;
	}
	return null;
}

function parseOpacityChannel(
	rawOpacity: string | null,
	rawChannel: string | null
): number | undefined {
	let opacity: number | undefined;
	if (rawOpacity != null) {
		const p = parseFloat(rawOpacity);
		if (!Number.isNaN(p) && p < 1) opacity = p;
	}
	if (rawChannel != null) {
		const p = parseFloat(rawChannel);
		if (!Number.isNaN(p) && p < 1) {
			opacity = opacity != null ? opacity * p : p;
		}
	}
	return opacity;
}

function elementToPathData(
	el: Element,
	root: Element,
	fit: { scale: number; translateX: number; translateY: number },
	layerId?: string
): PathData | null {
	const d = shapeElementToPathD(el);
	if (!d) return null;

	const local = composeElementTransform(el, root);
	const fitM: AffineMatrix = {
		a: fit.scale,
		b: 0,
		c: 0,
		d: fit.scale,
		e: fit.translateX,
		f: fit.translateY
	};
	// screen = fit * localCtm * p
	const finalM = multiplyAffine(fitM, local);
	const transformStr = isAffineIdentity(finalM) ? undefined : matrixToAttr(finalM);

	const rawStroke = resolvePresentation(el, 'stroke', root);
	const rawFill = resolvePresentation(el, 'fill', root);
	const rawStrokeWidth = resolvePresentation(el, 'stroke-width', root);
	const rawFillRule = resolvePresentation(el, 'fill-rule', root);
	const rawOpacity = resolvePresentation(el, 'opacity', root);
	const rawFillOpacity = resolvePresentation(el, 'fill-opacity', root);
	const rawStrokeOpacity = resolvePresentation(el, 'stroke-opacity', root);

	let stroke: string;
	let fill: string;
	const strokeIsPaint =
		rawStroke != null &&
		rawStroke !== '' &&
		rawStroke !== 'none' &&
		rawStroke !== 'transparent' &&
		!rawStroke.startsWith('url(');
	if (rawFill == null && strokeIsPaint) {
		fill = 'none';
		stroke = rawStroke!;
	} else {
		stroke =
			rawStroke == null || rawStroke === '' || rawStroke === 'none' || rawStroke === 'transparent'
				? 'none'
				: rawStroke.startsWith('url(')
					? 'none'
					: rawStroke;
		fill =
			rawFill == null || rawFill === ''
				? 'black'
				: rawFill === 'none' || rawFill === 'transparent'
					? 'none'
					: rawFill.startsWith('url(')
						? 'black'
						: rawFill;
	}

	const strokeWidth = Math.max(0, parseFloat(rawStrokeWidth ?? '1') || 1);
	const fillRule = rawFillRule === 'evenodd' ? 'evenodd' : 'nonzero';
	const opacity = parseOpacityChannel(rawOpacity, fill !== 'none' ? rawFillOpacity : rawStrokeOpacity);

	const pathData: PathData = {
		d,
		stroke,
		fill,
		strokeWidth,
		fillRule,
		...(transformStr ? { transform: transformStr } : {}),
		...(opacity !== undefined ? { opacity } : {}),
		...(layerId ? { layerId } : {})
	};
	return pathData;
}

/**
 * Parses an SVG string and extracts PathData[] along with counts of skipped or lossy SVG features.
 */
export function svgToPaths(svgString: string, options: SvgToPathsOptions = {}): SvgToPathsResult {
	const stats = emptyStats();

	if (typeof DOMParser === 'undefined' || !svgString?.trim()) {
		return { paths: [], stats };
	}

	const parser = new DOMParser();
	const doc = parser.parseFromString(svgString, 'image/svg+xml');
	const svgEl = doc.querySelector('svg');

	if (!svgEl) {
		return { paths: [], stats };
	}

	stats.clipPaths = doc.querySelectorAll('clipPath, [clip-path]').length;
	stats.gradients = doc.querySelectorAll('linearGradient, radialGradient').length;
	stats.images = doc.querySelectorAll('image').length;
	stats.useElements = doc.querySelectorAll('use').length;

	const fit = options.fitTransform || { scale: 1, translateX: 0, translateY: 0 };
	const paths: PathData[] = [];

	const candidates = svgEl.querySelectorAll('path, rect, circle, ellipse, line, polygon, polyline');
	for (const el of candidates) {
		if (isInSkipSubtree(el, svgEl)) continue;
		const tag = el.tagName.toLowerCase().replace(/^.*:/, '');
		if (!SHAPE_TAGS.has(tag)) continue;

		const pd = elementToPathData(el, svgEl, fit, options.layerId);
		if (!pd) {
			if (tag !== 'path') stats.droppedPrimitives++;
			continue;
		}
		paths.push(pd);
	}

	const uses = svgEl.querySelectorAll('use');
	for (const useEl of uses) {
		if (isInSkipSubtree(useEl, svgEl)) continue;
		const href =
			useEl.getAttribute('href') ||
			useEl.getAttribute('xlink:href') ||
			useEl.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
		if (!href || !href.startsWith('#')) continue;
		const id = href.slice(1);
		let target: Element | null = null;
		try {
			const esc =
				typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
					? CSS.escape(id)
					: id.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
			target = svgEl.querySelector(`#${esc}`);
		} catch {
			target = doc.getElementById(id);
		}
		if (!target) continue;
		const tag = target.tagName.toLowerCase().replace(/^.*:/, '');
		if (!SHAPE_TAGS.has(tag)) continue;

		const d = shapeElementToPathD(target);
		if (!d) {
			stats.droppedPrimitives++;
			continue;
		}

		const useLocal = composeElementTransform(useEl, svgEl);
		const ux = numAttr(useEl, 'x');
		const uy = numAttr(useEl, 'y');
		const useOffset: AffineMatrix = { a: 1, b: 0, c: 0, d: 1, e: ux, f: uy };
		const targetOwn = parseSvgTransform(target.getAttribute('transform')) ?? {
			...AFFINE_IDENTITY
		};
		let m = multiplyAffine(useLocal, useOffset);
		m = multiplyAffine(m, targetOwn);
		const fitM: AffineMatrix = {
			a: fit.scale,
			b: 0,
			c: 0,
			d: fit.scale,
			e: fit.translateX,
			f: fit.translateY
		};
		m = multiplyAffine(fitM, m);

		const styleEl = useEl;
		const rawStroke =
			resolvePresentation(styleEl, 'stroke', svgEl) ??
			resolvePresentation(target, 'stroke', svgEl);
		const rawFill =
			resolvePresentation(styleEl, 'fill', svgEl) ?? resolvePresentation(target, 'fill', svgEl);
		const rawStrokeWidth =
			resolvePresentation(styleEl, 'stroke-width', svgEl) ??
			resolvePresentation(target, 'stroke-width', svgEl);

		let stroke =
			rawStroke == null || rawStroke === 'none' || rawStroke === 'transparent'
				? 'none'
				: rawStroke;
		let fill =
			rawFill == null || rawFill === ''
				? 'black'
				: rawFill === 'none' || rawFill === 'transparent'
					? 'none'
					: rawFill;
		if (fill.startsWith('url(')) fill = 'black';
		if (stroke.startsWith('url(')) stroke = 'none';

		const strokeWidth = Math.max(0, parseFloat(rawStrokeWidth ?? '1') || 1);
		const transformStr = isAffineIdentity(m) ? undefined : matrixToAttr(m);

		paths.push({
			d,
			stroke,
			fill,
			strokeWidth,
			fillRule: 'nonzero',
			...(transformStr ? { transform: transformStr } : {}),
			...(options.layerId ? { layerId: options.layerId } : {})
		});
	}

	return { paths, stats };
}
