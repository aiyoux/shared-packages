/**
 * Squarified treemap layout for the storage inspector.
 *
 * Rectangles are proportional to bytes, and the squarified algorithm keeps
 * their aspect ratios near 1 so small files stay clickable instead of
 * degenerating into slivers — the property that makes GrandPerspective and
 * Disk Inventory X readable at a glance.
 */
export type TreemapInput = {
	id: string;
	name: string;
	/** Bytes. Zero-size entries are dropped: they cannot be drawn. */
	size: number;
	kind: 'file' | 'folder';
	/** Distinguishes ordinary files from project files and packs. */
	group?: 'plain' | 'project' | 'pack';
	children?: TreemapInput[];
};

export type TreemapRect = {
	id: string;
	name: string;
	size: number;
	kind: 'file' | 'folder';
	group: 'plain' | 'project' | 'pack';
	x: number;
	y: number;
	w: number;
	h: number;
	/** Nesting level; 0 for top-level entries. */
	depth: number;
};

type Box = { x: number; y: number; w: number; h: number };

function worstRatio(row: number[], length: number, scale: number): number {
	if (!row.length || length <= 0) return Number.POSITIVE_INFINITY;
	let sum = 0;
	let min = Number.POSITIVE_INFINITY;
	let max = 0;
	for (const v of row) {
		const s = v * scale;
		sum += s;
		if (s < min) min = s;
		if (s > max) max = s;
	}
	if (sum <= 0) return Number.POSITIVE_INFINITY;
	const side = length * length;
	return Math.max((side * max) / (sum * sum), (sum * sum) / (side * min));
}

/**
 * One level of squarified layout. Returns a rect per input, in input order.
 * Entries too small to draw at this size are omitted rather than rendered as
 * invisible slivers.
 */
function squarify(items: Array<{ id: string; size: number }>, box: Box): Map<string, Box> {
	const out = new Map<string, Box>();
	const total = items.reduce((n, i) => n + i.size, 0);
	if (total <= 0 || box.w <= 0 || box.h <= 0) return out;

	const scale = (box.w * box.h) / total;
	let rest = [...items];
	let area: Box = { ...box };

	while (rest.length) {
		const short = Math.min(area.w, area.h);
		const row: Array<{ id: string; size: number }> = [];
		let bestWorst = Number.POSITIVE_INFINITY;

		while (rest.length) {
			const candidate = [...row.map((r) => r.size), rest[0]!.size];
			const worst = worstRatio(candidate, short, scale);
			if (row.length && worst > bestWorst) break;
			bestWorst = worst;
			row.push(rest.shift()!);
		}

		const rowSum = row.reduce((n, r) => n + r.size, 0);
		const thickness = short > 0 ? (rowSum * scale) / short : 0;
		let cursor = 0;
		for (const item of row) {
			const frac = rowSum > 0 ? item.size / rowSum : 0;
			if (area.w >= area.h) {
				const h = short * frac;
				out.set(item.id, { x: area.x, y: area.y + cursor, w: thickness, h });
				cursor += h;
			} else {
				const w = short * frac;
				out.set(item.id, { x: area.x + cursor, y: area.y, w, h: thickness });
				cursor += w;
			}
		}

		if (area.w >= area.h) {
			area = { x: area.x + thickness, y: area.y, w: area.w - thickness, h: area.h };
		} else {
			area = { x: area.x, y: area.y + thickness, w: area.w, h: area.h - thickness };
		}
		if (area.w <= 0.5 || area.h <= 0.5) break;
	}
	return out;
}

/** Below this, a rect is not worth drawing or hit-testing. */
const MIN_DRAWN_PX = 3;
/** Nested children are only laid out when the parent has room for the frame. */
const MIN_NEST_PX = 28;

/**
 * Flatten a size tree into drawable rectangles.
 *
 * Folders are drawn as a frame with their children laid out inside, so the
 * picture reads as containment; a folder too small to hold a legible frame is
 * drawn as a single block instead.
 */
export function layoutTreemap(
	roots: TreemapInput[],
	width: number,
	height: number,
	maxDepth = 4
): TreemapRect[] {
	const out: TreemapRect[] = [];

	const walk = (items: TreemapInput[], box: Box, depth: number) => {
		if (depth > maxDepth || box.w < MIN_DRAWN_PX || box.h < MIN_DRAWN_PX) return;
		const drawable = items.filter((i) => i.size > 0);
		if (!drawable.length) return;
		const placed = squarify(
			drawable.map((i) => ({ id: i.id, size: i.size })),
			box
		);
		for (const item of drawable) {
			const rect = placed.get(item.id);
			if (!rect || rect.w < MIN_DRAWN_PX || rect.h < MIN_DRAWN_PX) continue;
			out.push({
				id: item.id,
				name: item.name,
				size: item.size,
				kind: item.kind,
				group: item.group ?? 'plain',
				depth,
				...rect
			});
			const kids = item.children ?? [];
			if (
				kids.length &&
				rect.w >= MIN_NEST_PX &&
				rect.h >= MIN_NEST_PX &&
				depth + 1 <= maxDepth
			) {
				// Inset so the parent's frame stays visible around its children.
				const pad = 1;
				const header = Math.min(12, Math.max(0, rect.h - MIN_NEST_PX + 8));
				walk(kids, {
					x: rect.x + pad,
					y: rect.y + header,
					w: rect.w - pad * 2,
					h: rect.h - header - pad
				}, depth + 1);
			}
		}
	};

	walk(roots, { x: 0, y: 0, w: width, h: height }, 0);
	return out;
}

/** Bytes → short human string. Shared by the inspector and its tooltips. */
export function formatSize(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
