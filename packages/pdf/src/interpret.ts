import type {
	PdfHandle,
	PdfInterpretResult,
	PdfIrElement,
	PdfIrGroupElement,
	PdfPageFit
} from './types.js';
import { calculatePageFit } from './range.js';
import { getPage, loadPdfjsLib } from './engine.js';
import { rasterToPngDataUrl } from './png.js';

const DrawOPS = {
	moveTo: 0,
	lineTo: 1,
	curveTo: 2,
	quadraticCurveTo: 3,
	closePath: 4
} as const;

type Mat = [number, number, number, number, number, number];

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function newId(): string {
	return crypto.randomUUID();
}

function multiply(m1: Mat, m2: Mat): Mat {
	return [
		m1[0] * m2[0] + m1[2] * m2[1],
		m1[1] * m2[0] + m1[3] * m2[1],
		m1[0] * m2[2] + m1[2] * m2[3],
		m1[1] * m2[2] + m1[3] * m2[3],
		m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
		m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
	];
}

function applyMat(m: Mat, x: number, y: number): { x: number; y: number } {
	return {
		x: m[0] * x + m[2] * y + m[4],
		y: m[1] * x + m[3] * y + m[5]
	};
}

function cloneMat(m: Mat): Mat {
	return [m[0], m[1], m[2], m[3], m[4], m[5]];
}

function nfmt(value: number): string {
	if (!Number.isFinite(value)) return '0';
	return String(Math.round(value * 1000) / 1000);
}

function unit(v: number): number {
	return v > 1 ? v / 255 : v;
}

function cssRgb(r: number, g: number, b: number): string {
	const c = (v: number) => Math.max(0, Math.min(255, Math.round(unit(v) * 255)));
	return `#${[c(r), c(g), c(b)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

function cssGray(g: number): string {
	return cssRgb(g, g, g);
}

function cssCmyk(c: number, m: number, y: number, k: number): string {
	const r = 1 - Math.min(1, unit(c) * (1 - unit(k)) + unit(k));
	const g = 1 - Math.min(1, unit(m) * (1 - unit(k)) + unit(k));
	const b = 1 - Math.min(1, unit(y) * (1 - unit(k)) + unit(k));
	return cssRgb(r, g, b);
}

type GraphicsState = {
	ctm: Mat;
	fill: string;
	stroke: string;
	lineWidth: number;
	fillAlpha: number;
	strokeAlpha: number;
};

function defaultState(): GraphicsState {
	return {
		ctm: cloneMat(IDENTITY),
		fill: '#000000',
		stroke: '#000000',
		lineWidth: 1,
		fillAlpha: 1,
		strokeAlpha: 1
	};
}

type Mapper = {
	fit: PdfPageFit;
	xMin: number;
	yMax: number;
};

function mapPoint(m: Mapper, ctm: Mat, x: number, y: number): { x: number; y: number } {
	const p = applyMat(ctm, x, y);
	return {
		x: m.fit.x + (p.x - m.xMin) * m.fit.scale,
		y: m.fit.y + (m.yMax - p.y) * m.fit.scale
	};
}

function drawOpsToPath(data: ArrayLike<number>, m: Mapper, ctm: Mat): string {
	const parts: string[] = [];
	let i = 0;
	const len = data.length;
	while (i < len) {
		const op = data[i++] as number;
		switch (op) {
			case DrawOPS.moveTo: {
				const p = mapPoint(m, ctm, data[i++] as number, data[i++] as number);
				parts.push(`M${nfmt(p.x)} ${nfmt(p.y)}`);
				break;
			}
			case DrawOPS.lineTo: {
				const p = mapPoint(m, ctm, data[i++] as number, data[i++] as number);
				parts.push(`L${nfmt(p.x)} ${nfmt(p.y)}`);
				break;
			}
			case DrawOPS.curveTo: {
				const p1 = mapPoint(m, ctm, data[i++] as number, data[i++] as number);
				const p2 = mapPoint(m, ctm, data[i++] as number, data[i++] as number);
				const p3 = mapPoint(m, ctm, data[i++] as number, data[i++] as number);
				parts.push(
					`C${nfmt(p1.x)} ${nfmt(p1.y)} ${nfmt(p2.x)} ${nfmt(p2.y)} ${nfmt(p3.x)} ${nfmt(p3.y)}`
				);
				break;
			}
			case DrawOPS.quadraticCurveTo: {
				const p1 = mapPoint(m, ctm, data[i++] as number, data[i++] as number);
				const p2 = mapPoint(m, ctm, data[i++] as number, data[i++] as number);
				parts.push(`Q${nfmt(p1.x)} ${nfmt(p1.y)} ${nfmt(p2.x)} ${nfmt(p2.y)}`);
				break;
			}
			case DrawOPS.closePath:
				parts.push('Z');
				break;
			default:
				return parts.join(' ');
		}
	}
	return parts.join(' ');
}

function pathPaint(op: number, OPS: Record<string, number>): {
	fill: boolean;
	stroke: boolean;
	eo: boolean;
} {
	const fill =
		op === OPS.fill ||
		op === OPS.eoFill ||
		op === OPS.fillStroke ||
		op === OPS.eoFillStroke ||
		op === OPS.closeFillStroke ||
		op === OPS.closeEOFillStroke;
	const stroke =
		op === OPS.stroke ||
		op === OPS.closeStroke ||
		op === OPS.fillStroke ||
		op === OPS.eoFillStroke ||
		op === OPS.closeFillStroke ||
		op === OPS.closeEOFillStroke;
	const eo =
		op === OPS.eoFill || op === OPS.eoFillStroke || op === OPS.closeEOFillStroke;
	return { fill, stroke, eo };
}

function scaleOf(ctm: Mat): number {
	return (Math.hypot(ctm[0], ctm[1]) + Math.hypot(ctm[2], ctm[3])) / 2;
}

type TextItem = {
	str: string;
	fontName: string;
	fill: string;
	x: number;
	y: number;
	width: number;
	height: number;
};

function groupText(items: TextItem[]): TextItem[] {
	const groups: TextItem[] = [];
	for (const item of items) {
		if (!item.str) continue;
		const prev = groups[groups.length - 1];
		const em = Math.max(prev?.height ?? item.height, 1e-6);
		if (
			prev &&
			prev.fontName === item.fontName &&
			prev.fill === item.fill &&
			Math.abs(prev.y - item.y) < 0.5 &&
			item.x - (prev.x + prev.width) < em
		) {
			prev.str += item.str;
			prev.width = item.x + item.width - prev.x;
			prev.height = Math.max(prev.height, item.height);
		} else {
			groups.push({ ...item });
		}
	}
	return groups;
}

function applyGState(state: GraphicsState, args: unknown) {
	const pairs: unknown[] = Array.isArray(args) ? args : [];
	for (const pair of pairs) {
		if (!Array.isArray(pair) || pair.length < 2) continue;
		const key = pair[0];
		const value = pair[1];
		if (key === 'LW' && typeof value === 'number') state.lineWidth = value;
		else if (key === 'CA' && typeof value === 'number') state.strokeAlpha = value;
		else if (key === 'ca' && typeof value === 'number') state.fillAlpha = value;
		else if (key === 'Font' && Array.isArray(value) && typeof value[1] === 'number') {
			// font size lives on the text state; ignore here
		}
	}
}

async function getObj(objs: { has?: (id: string) => boolean; get: (id: string, cb?: (v: unknown) => void) => unknown }, id: string): Promise<unknown> {
	try {
		if (typeof objs.has === 'function' && objs.has(id)) {
			return objs.get(id);
		}
	} catch {
		// fall through to callback form
	}
	return new Promise((resolve) => {
		try {
			const existing = objs.get(id, resolve);
			if (existing && existing !== undefined && typeof existing !== 'function') {
				resolve(existing);
			}
		} catch {
			resolve(null);
		}
	});
}

function imgToSrc(img: unknown): string | null {
	if (!img || typeof img !== 'object') return null;
	const rec = img as {
		width?: number;
		height?: number;
		kind?: number;
		data?: Uint8Array | Uint8ClampedArray;
		bitmap?: ImageBitmap;
	};
	if (rec.data && rec.width && rec.height) {
		return rasterToPngDataUrl({
			width: rec.width,
			height: rec.height,
			kind: rec.kind,
			data: rec.data
		});
	}
	return null;
}

type OpList = { fnArray: number[]; argsArray: unknown[][] };

export async function interpretPage(
	handle: PdfHandle,
	index: number,
	opts: { targetWidth: number; targetHeight: number }
): Promise<PdfInterpretResult> {
	const pdfjs = await loadPdfjsLib();
	const OPS = pdfjs.OPS as unknown as Record<string, number>;
	const page = await getPage(handle, index);
	const [xMin, yMin, xMax, yMax] = page.view as [number, number, number, number];
	const pageW = xMax - xMin;
	const pageH = yMax - yMin;
	const fit = calculatePageFit(pageW, pageH, opts.targetWidth, opts.targetHeight);
	const mapper: Mapper = { fit, xMin, yMax };

	const stats = {
		texts: 0,
		images: 0,
		paths: 0,
		groups: 0,
		chips: 0,
		unmappedOps: 0
	};

	const root: PdfIrElement[] = [];
	const groupStack: PdfIrGroupElement[] = [];
	const emit = (el: PdfIrElement) => {
		const top = groupStack[groupStack.length - 1];
		if (top) top.children.push(el);
		else root.push(el);
	};

	let opList: OpList;
	try {
		opList = (await page.getOperatorList()) as OpList;
	} catch {
		return { width: opts.targetWidth, height: opts.targetHeight, elements: root, stats };
	}

	const handled = new Set<number>(
		[
			OPS.dependency,
			OPS.setLineWidth,
			OPS.setLineCap,
			OPS.setLineJoin,
			OPS.setMiterLimit,
			OPS.setDash,
			OPS.setRenderingIntent,
			OPS.setFlatness,
			OPS.setGState,
			OPS.save,
			OPS.restore,
			OPS.transform,
			OPS.moveTo,
			OPS.lineTo,
			OPS.curveTo,
			OPS.curveTo2,
			OPS.curveTo3,
			OPS.closePath,
			OPS.rectangle,
			OPS.stroke,
			OPS.closeStroke,
			OPS.fill,
			OPS.eoFill,
			OPS.fillStroke,
			OPS.eoFillStroke,
			OPS.closeFillStroke,
			OPS.closeEOFillStroke,
			OPS.endPath,
			OPS.clip,
			OPS.eoClip,
			OPS.beginText,
			OPS.endText,
			OPS.setCharSpacing,
			OPS.setWordSpacing,
			OPS.setHScale,
			OPS.setLeading,
			OPS.setFont,
			OPS.setTextRenderingMode,
			OPS.setTextRise,
			OPS.setTextMatrix,
			OPS.moveText,
			OPS.setLeadingMoveText,
			OPS.nextLine,
			OPS.showText,
			OPS.showSpacedText,
			OPS.nextLineShowText,
			OPS.nextLineSetSpacingShowText,
			OPS.setFillColorSpace,
			OPS.setStrokeColorSpace,
			OPS.setFillColor,
			OPS.setStrokeColor,
			OPS.setFillColorN,
			OPS.setStrokeColorN,
			OPS.setFillGray,
			OPS.setStrokeGray,
			OPS.setFillRGBColor,
			OPS.setStrokeRGBColor,
			OPS.setFillCMYKColor,
			OPS.setStrokeCMYKColor,
			OPS.shadingFill,
			OPS.beginInlineImage,
			OPS.beginImageData,
			OPS.endInlineImage,
			OPS.paintXObject,
			OPS.markPoint,
			OPS.markPointProps,
			OPS.beginMarkedContent,
			OPS.beginMarkedContentProps,
			OPS.endMarkedContent,
			OPS.beginCompat,
			OPS.endCompat,
			OPS.paintFormXObjectBegin,
			OPS.paintFormXObjectEnd,
			OPS.beginGroup,
			OPS.endGroup,
			OPS.beginAnnotation,
			OPS.endAnnotation,
			OPS.paintImageMaskXObject,
			OPS.paintImageMaskXObjectGroup,
			OPS.paintImageXObject,
			OPS.paintInlineImageXObject,
			OPS.paintInlineImageXObjectGroup,
			OPS.paintImageXObjectRepeat,
			OPS.paintImageMaskXObjectRepeat,
			OPS.paintSolidColorImageMask,
			OPS.constructPath,
			OPS.setStrokeTransparent,
			OPS.setFillTransparent,
			OPS.rawFillPath
		].filter((n) => typeof n === 'number')
	);

	const stack: GraphicsState[] = [];
	let gs = defaultState();

	const emitPath = (d: string, op: number) => {
		if (!d) return;
		const paint = pathPaint(op, OPS);
		if (!paint.fill && !paint.stroke) return;
		const strokeWidth = gs.lineWidth * scaleOf(gs.ctm) * fit.scale;
		emit({
			type: 'path',
			id: newId(),
			d,
			fill: paint.fill ? gs.fill : 'none',
			stroke: paint.stroke ? gs.stroke : 'none',
			strokeWidth: paint.stroke ? strokeWidth : 0,
			fillRule: paint.eo ? 'evenodd' : 'nonzero',
			opacity: gs.fillAlpha !== 1 ? gs.fillAlpha : undefined
		});
		stats.paths++;
	};

	const emitImage = async (imgOrId: unknown) => {
		let src: string | null = null;
		if (typeof imgOrId === 'string') {
			const objs =
				imgOrId.startsWith('g_')
					? (page.commonObjs as unknown as Parameters<typeof getObj>[0])
					: (page.objs as unknown as Parameters<typeof getObj>[0]);
			src = imgToSrc(await getObj(objs, imgOrId));
		} else {
			src = imgToSrc(imgOrId);
		}
		if (!src) {
			stats.unmappedOps++;
			return;
		}
		const p0 = mapPoint(mapper, gs.ctm, 0, 0);
		const p1 = mapPoint(mapper, gs.ctm, 1, 0);
		const p2 = mapPoint(mapper, gs.ctm, 1, 1);
		const p3 = mapPoint(mapper, gs.ctm, 0, 1);
		const xs = [p0.x, p1.x, p2.x, p3.x];
		const ys = [p0.y, p1.y, p2.y, p3.y];
		const x = Math.min(...xs);
		const y = Math.min(...ys);
		emit({
			type: 'image',
			id: newId(),
			src,
			x,
			y,
			width: Math.max(...xs) - x,
			height: Math.max(...ys) - y,
			opacity: gs.fillAlpha !== 1 ? gs.fillAlpha : undefined
		});
		stats.images++;
	};

	for (let i = 0; i < opList.fnArray.length; i++) {
		const fn = opList.fnArray[i]!;
		const args = (opList.argsArray[i] ?? []) as unknown[];
		if (!handled.has(fn)) stats.unmappedOps++;

		try {
			if (fn === OPS.save) {
				stack.push({
					...gs,
					ctm: cloneMat(gs.ctm)
				});
			} else if (fn === OPS.restore) {
				const popped = stack.pop();
				if (popped) gs = popped;
			} else if (fn === OPS.transform && args.length >= 6) {
				gs.ctm = multiply(gs.ctm, args as unknown as Mat);
			} else if (fn === OPS.setLineWidth && typeof args[0] === 'number') {
				gs.lineWidth = args[0];
			} else if (fn === OPS.setGState) {
				applyGState(gs, args[0] ?? args);
			} else if (fn === OPS.setFillRGBColor) {
				gs.fill = cssRgb(Number(args[0]), Number(args[1]), Number(args[2]));
			} else if (fn === OPS.setStrokeRGBColor) {
				gs.stroke = cssRgb(Number(args[0]), Number(args[1]), Number(args[2]));
			} else if (fn === OPS.setFillGray) {
				gs.fill = cssGray(Number(args[0]));
			} else if (fn === OPS.setStrokeGray) {
				gs.stroke = cssGray(Number(args[0]));
			} else if (fn === OPS.setFillCMYKColor) {
				gs.fill = cssCmyk(Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3]));
			} else if (fn === OPS.setStrokeCMYKColor) {
				gs.stroke = cssCmyk(Number(args[0]), Number(args[1]), Number(args[2]), Number(args[3]));
			} else if (fn === OPS.setFillTransparent) {
				gs.fillAlpha = 0;
			} else if (fn === OPS.setStrokeTransparent) {
				gs.strokeAlpha = 0;
			} else if (fn === OPS.constructPath) {
				const op = args[0] as number;
				const data = args[1];
				const buf = Array.isArray(data) ? data[0] : data;
				if (buf && (buf as ArrayLike<number>).length) {
					emitPath(drawOpsToPath(buf as ArrayLike<number>, mapper, gs.ctm), op);
				}
			} else if (fn === OPS.paintFormXObjectBegin) {
				const matrix = (args[0] as Mat | undefined) ?? IDENTITY;
				if (matrix) gs.ctm = multiply(gs.ctm, matrix as Mat);
				const group: PdfIrGroupElement = {
					type: 'group',
					id: newId(),
					children: []
				};
				emit(group);
				groupStack.push(group);
				stats.groups++;
			} else if (fn === OPS.paintFormXObjectEnd) {
				groupStack.pop();
			} else if (fn === OPS.beginGroup) {
				const group: PdfIrGroupElement = {
					type: 'group',
					id: newId(),
					children: []
				};
				emit(group);
				groupStack.push(group);
				stats.groups++;
			} else if (fn === OPS.endGroup) {
				groupStack.pop();
			} else if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
				await emitImage(args[0]);
			} else if (fn === OPS.paintInlineImageXObject) {
				await emitImage(args[0]);
			}
		} catch {
			stats.unmappedOps++;
		}
	}

	const textContent = await page.getTextContent();
	const rawText: TextItem[] = [];
	for (const item of textContent.items) {
		if (!item || typeof item !== 'object' || !('str' in item)) continue;
		const it = item as {
			str: string;
			transform: number[];
			width: number;
			height: number;
			fontName?: string;
		};
		const t = it.transform ?? [1, 0, 0, 1, 0, 0];
		rawText.push({
			str: it.str,
			fontName: it.fontName ?? '',
			fill: '#000000',
			x: t[4] ?? 0,
			y: t[5] ?? 0,
			width: it.width ?? 0,
			height: it.height || Math.hypot(t[2] ?? 0, t[3] ?? 0) || Math.hypot(t[0] ?? 0, t[1] ?? 0)
		});
	}
	for (const g of groupText(rawText)) {
		const fontSize = g.height * fit.scale;
		const x = fit.x + (g.x - xMin) * fit.scale;
		const baseline = fit.y + (yMax - g.y) * fit.scale;
		root.push({
			type: 'text',
			id: newId(),
			str: g.str,
			x,
			y: baseline - fontSize,
			width: g.width * fit.scale,
			height: fontSize,
			fill: g.fill,
			fontSize,
			d: ''
		});
		stats.texts++;
	}

	return { width: opts.targetWidth, height: opts.targetHeight, elements: root, stats };
}
