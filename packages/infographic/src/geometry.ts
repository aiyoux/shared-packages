import { resolveColorToken } from './theme.js';
import type { IgfxObject, ResolvedNode, Theme } from './types.js';

export const MAX_PATH_D_CHARS = 32 * 1024;
export const MAX_PATH_COMMANDS = 4096;

const PATH_TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;

/** Parse and re-emit path `d` as commands + numbers. Drops markup and unknown tokens. */
export function sanitizePathD(d: string): string {
	if (!d) return '';
	let src = d.replace(/[<>]/g, '');
	if (src.length > MAX_PATH_D_CHARS) src = src.slice(0, MAX_PATH_D_CHARS);
	// Words like "script" contain command letters; drop any run that isn't only commands.
	src = src.replace(/[A-Za-z]+/g, (word) =>
		[...word].every((ch) => 'MmLlHhVvCcSsQqTtAaZz'.includes(ch)) ? word : ' '
	);
	const parts: string[] = [];
	let commands = 0;
	let current: string[] | null = null;
	const flush = () => {
		if (current && current.length > 0) parts.push(current.join(' '));
		current = null;
	};
	PATH_TOKEN.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = PATH_TOKEN.exec(src)) !== null) {
		if (match[1]) {
			if (commands >= MAX_PATH_COMMANDS) break;
			flush();
			commands += 1;
			current = [match[1]];
		} else if (current) {
			const n = Number(match[2]);
			if (Number.isFinite(n)) current.push(String(n));
		}
	}
	flush();
	return parts.join(' ');
}

function styleColor(obj: IgfxObject, theme: Theme, fallbackIndex = 0): string {
	const raw = obj.style?.fill ?? obj.style?.color;
	if (typeof raw === 'string' || typeof raw === 'number') {
		return resolveColorToken(theme, raw, fallbackIndex);
	}
	return resolveColorToken(theme, fallbackIndex);
}

function styleStroke(obj: IgfxObject, theme: Theme, fallback: string): string {
	const raw = obj.style?.stroke;
	if (typeof raw === 'string' || typeof raw === 'number') {
		return resolveColorToken(theme, raw);
	}
	return fallback;
}

function styleStrokeWidth(obj: IgfxObject, fallback: number): number {
	const raw = obj.style?.strokeWidth;
	return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

function geometryGroup(id: string, children: ResolvedNode[]): ResolvedNode {
	return {
		id,
		tag: 'g',
		attrs: { opacity: '1' },
		children
	};
}

export function renderShape(
	obj: IgfxObject,
	layout: { x: number; y: number; w: number; h: number },
	theme: Theme
): ResolvedNode {
	const primitive = obj.shape?.primitive ?? 'rect';
	const { x, y, w, h } = layout;
	const fill = styleColor(obj, theme);
	if (primitive === 'line') {
		return geometryGroup(obj.id, [
			{
				id: `${obj.id}:shape`,
				tag: 'line',
				attrs: {
					x1: String(x),
					y1: String(y),
					x2: String(x + w),
					y2: String(y + h),
					stroke: styleStroke(obj, theme, fill),
					'stroke-width': String(styleStrokeWidth(obj, 2)),
					'stroke-linecap': 'round'
				}
			}
		]);
	}
	if (primitive === 'ellipse') {
		return geometryGroup(obj.id, [
			{
				id: `${obj.id}:shape`,
				tag: 'ellipse',
				attrs: {
					cx: String(x + w / 2),
					cy: String(y + h / 2),
					rx: String(Math.max(0, w / 2)),
					ry: String(Math.max(0, h / 2)),
					fill
				}
			}
		]);
	}
	const radius = Math.max(0, theme.radius);
	return geometryGroup(obj.id, [
		{
			id: `${obj.id}:shape`,
			tag: 'rect',
			attrs: {
				x: String(x),
				y: String(y),
				width: String(w),
				height: String(h),
				fill,
				rx: String(Math.min(radius, w / 2, h / 2))
			}
		}
	]);
}

export function renderPath(
	obj: IgfxObject,
	layout: { x: number; y: number; w: number; h: number },
	theme: Theme
): ResolvedNode {
	const closed = obj.path?.closed === true;
	let d = sanitizePathD(obj.path?.d ?? '');
	if (closed && d && !/[Zz]\s*$/.test(d)) d = `${d} Z`;
	const color = styleColor(obj, theme);
	const fillRaw = obj.style?.fill;
	const fill =
		typeof fillRaw === 'string' || typeof fillRaw === 'number'
			? resolveColorToken(theme, fillRaw)
			: closed
				? color
				: 'none';
	return geometryGroup(obj.id, [
		{
			id: `${obj.id}:path`,
			tag: 'path',
			attrs: {
				d,
				fill,
				stroke: styleStroke(obj, theme, color),
				'stroke-width': String(styleStrokeWidth(obj, 3)),
				'stroke-linejoin': 'round',
				'stroke-linecap': 'round',
				transform: `translate(${layout.x} ${layout.y})`
			}
		}
	]);
}

export function renderGeometry(
	obj: IgfxObject,
	layout: { x: number; y: number; w: number; h: number },
	theme: Theme
): ResolvedNode {
	if (obj.kind === 'path') return renderPath(obj, layout, theme);
	return renderShape(obj, layout, theme);
}
