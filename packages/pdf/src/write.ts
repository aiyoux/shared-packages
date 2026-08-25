import {
	PDFDocument,
	StandardFonts,
	concatTransformationMatrix,
	degrees,
	popGraphicsState,
	pushGraphicsState,
	rgb,
	type PDFFont,
	type PDFImage,
	type PDFPage,
	type RGB
} from 'pdf-lib';
import type { PdfIrElement, PdfTransform } from './types.js';

export type PdfWritePage = {
	width: number;
	height: number;
	elements: PdfIrElement[];
};

function parseColor(css: string | undefined): RGB | undefined {
	if (!css || css === 'none' || css === 'transparent') return undefined;
	const raw = css.trim();
	const short = /^#([0-9a-f]{3})$/i.exec(raw);
	if (short) {
		const [r, g, b] = short[1]!.split('').map((ch) => parseInt(ch + ch, 16) / 255);
		return rgb(r!, g!, b!);
	}
	const long = /^#([0-9a-f]{6})$/i.exec(raw);
	if (long) {
		const n = parseInt(long[1]!, 16);
		return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
	}
	const rgbm = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(raw);
	if (rgbm) {
		const u = (v: string) => {
			const n = Number(v);
			return n > 1 ? n / 255 : n;
		};
		return rgb(u(rgbm[1]!), u(rgbm[2]!), u(rgbm[3]!));
	}
	return undefined;
}

function decodeDataUrl(src: string): { mime: string; bytes: Uint8Array } | null {
	const m = /^data:([^;]+);base64,(.+)$/i.exec(src);
	if (!m) return null;
	const b64 = m[2]!;
	const bytes =
		typeof Buffer !== 'undefined'
			? new Uint8Array(Buffer.from(b64, 'base64'))
			: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
	return { mime: m[1]!, bytes };
}

function localBox(el: PdfIrElement): { x: number; y: number; width: number; height: number } {
	if (el.type === 'group') {
		if (!el.children.length) return { x: 0, y: 0, width: 0, height: 0 };
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const child of el.children) {
			const b = localBox(child);
			minX = Math.min(minX, b.x);
			minY = Math.min(minY, b.y);
			maxX = Math.max(maxX, b.x + b.width);
			maxY = Math.max(maxY, b.y + b.height);
		}
		return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
	}
	if (el.type === 'path') {
		const nums = el.d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
		if (!nums || nums.length < 2) return { x: 0, y: 0, width: 0, height: 0 };
		const xs: number[] = [];
		const ys: number[] = [];
		for (let i = 0; i + 1 < nums.length; i += 2) {
			xs.push(Number(nums[i]));
			ys.push(Number(nums[i + 1]));
		}
		if (!xs.length) return { x: 0, y: 0, width: 0, height: 0 };
		const minX = Math.min(...xs);
		const minY = Math.min(...ys);
		return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
	}
	if (el.type === 'text' && el.d) {
		const nums = el.d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
		if (nums && nums.length >= 2) {
			const xs: number[] = [];
			const ys: number[] = [];
			for (let i = 0; i + 1 < nums.length; i += 2) {
				xs.push(Number(nums[i]));
				ys.push(Number(nums[i + 1]));
			}
			if (xs.length) {
				const minX = Math.min(...xs);
				const minY = Math.min(...ys);
				return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
			}
		}
	}
	if ('x' in el && 'y' in el && 'width' in el && 'height' in el) {
		return { x: el.x, y: el.y, width: el.width, height: el.height };
	}
	return { x: 0, y: 0, width: 0, height: 0 };
}

function pushYDown(page: PDFPage, pageH: number) {
	page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, -1, 0, pageH));
}

function popGS(page: PDFPage) {
	page.pushOperators(popGraphicsState());
}

function applyTransform(page: PDFPage, t: PdfTransform | undefined, box: { x: number; y: number; width: number; height: number }) {
	if (!t) return;
	if (t.x || t.y) page.pushOperators(concatTransformationMatrix(1, 0, 0, 1, t.x, t.y ?? 0));
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	if (t.rotation) {
		const c = Math.cos(t.rotation);
		const s = Math.sin(t.rotation);
		page.pushOperators(
			concatTransformationMatrix(1, 0, 0, 1, cx, cy),
			concatTransformationMatrix(c, s, -s, c, 0, 0),
			concatTransformationMatrix(1, 0, 0, 1, -cx, -cy)
		);
	}
	if ((t.sx != null && t.sx !== 1) || (t.sy != null && t.sy !== 1)) {
		page.pushOperators(
			concatTransformationMatrix(1, 0, 0, 1, cx, cy),
			concatTransformationMatrix(t.sx ?? 1, 0, 0, t.sy ?? 1, 0, 0),
			concatTransformationMatrix(1, 0, 0, 1, -cx, -cy)
		);
	}
}

const imageCache = new WeakMap<PDFDocument, Map<string, PDFImage>>();

async function embedSrc(doc: PDFDocument, src: string): Promise<PDFImage | null> {
	let cache = imageCache.get(doc);
	if (!cache) {
		cache = new Map();
		imageCache.set(doc, cache);
	}
	const hit = cache.get(src);
	if (hit) return hit;
	const decoded = decodeDataUrl(src);
	if (!decoded) return null;
	try {
		const img = decoded.mime.includes('jpeg') || decoded.mime.includes('jpg')
			? await doc.embedJpg(decoded.bytes)
			: await doc.embedPng(decoded.bytes);
		cache.set(src, img);
		return img;
	} catch {
		return null;
	}
}

type FontSet = {
	helvetica: PDFFont;
	times: PDFFont;
	courier: PDFFont;
};

function pickFont(name: string | undefined, fonts: FontSet): PDFFont {
	const n = (name || '').toLowerCase();
	if (n.includes('times') || n.includes('roman') || n.includes('georgia')) return fonts.times;
	if (n.includes('courier') || n.includes('mono')) return fonts.courier;
	return fonts.helvetica;
}

async function drawElement(
	doc: PDFDocument,
	page: PDFPage,
	el: PdfIrElement,
	pageH: number,
	fonts: FontSet,
	flipped: boolean
): Promise<void> {
	if (el.hidden) return;

	const enterYDown = () => {
		if (!flipped) pushYDown(page, pageH);
	};
	const leaveYDown = () => {
		if (!flipped) popGS(page);
	};

	if (el.type === 'group') {
		enterYDown();
		page.pushOperators(pushGraphicsState());
		applyTransform(page, el.transform, localBox(el));
		for (const child of el.children) {
			await drawElement(doc, page, child, pageH, fonts, true);
		}
		popGS(page);
		leaveYDown();
		return;
	}

	if (el.type === 'text' && !el.d) {
		if (flipped) {
			// Current space is y-down (IR). Undo the flip around the baseline so
			// glyphs are not mirrored, then draw in IR coordinates.
			page.pushOperators(pushGraphicsState());
			applyTransform(page, el.transform, localBox(el));
			const baseline = el.y + el.fontSize;
			page.pushOperators(
				concatTransformationMatrix(1, 0, 0, 1, el.x, baseline),
				concatTransformationMatrix(1, 0, 0, -1, 0, 0)
			);
			const color = parseColor(el.fill) ?? rgb(0, 0, 0);
			const sx = el.transform?.sx ?? 1;
			const size = Math.max(1, el.fontSize * Math.abs(el.transform?.sy ?? sx));
			try {
				page.drawText(el.str, {
					x: 0,
					y: 0,
					size,
					font: pickFont(el.fontName, fonts),
					color,
					opacity: el.opacity
				});
			} catch {
				// Standard fonts cannot encode every Unicode scalar.
			}
			popGS(page);
			return;
		}
		const color = parseColor(el.fill) ?? rgb(0, 0, 0);
		const t = el.transform;
		const sx = t?.sx ?? 1;
		const size = Math.max(1, el.fontSize * Math.abs(t?.sy ?? sx));
		const x = el.x + (t?.x ?? 0);
		const y = pageH - (el.y + el.fontSize + (t?.y ?? 0));
		try {
			page.drawText(el.str, {
				x,
				y,
				size,
				font: pickFont(el.fontName, fonts),
				color,
				opacity: el.opacity,
				rotate: t?.rotation ? degrees(-((t.rotation * 180) / Math.PI)) : undefined
			});
		} catch {
			// Standard fonts cannot encode every Unicode scalar.
		}
		return;
	}

	enterYDown();
	page.pushOperators(pushGraphicsState());
	applyTransform(page, el.transform, localBox(el));

	if (el.type === 'text' && el.d) {
		const color = parseColor(el.fill) ?? rgb(0, 0, 0);
		page.drawSvgPath(el.d, { x: 0, y: 0, color, opacity: el.opacity });
	} else if (el.type === 'path') {
		const fill = parseColor(el.fill);
		const stroke = parseColor(el.stroke);
		if (fill || stroke) {
			page.drawSvgPath(el.d, {
				x: 0,
				y: 0,
				color: fill,
				borderColor: stroke,
				borderWidth: stroke && el.strokeWidth > 0 ? el.strokeWidth : undefined,
				opacity: el.opacity
			});
		}
	} else if (el.type === 'image' || el.type === 'chip') {
		const img = await embedSrc(doc, el.src);
		if (img) {
			page.drawImage(img, {
				x: el.x,
				y: el.y,
				width: el.width,
				height: el.height,
				opacity: el.type === 'image' ? el.opacity : undefined
			});
		}
	}

	popGS(page);
	leaveYDown();
}

export async function writePdf(pages: PdfWritePage[]): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const fonts: FontSet = {
		helvetica: await doc.embedFont(StandardFonts.Helvetica),
		times: await doc.embedFont(StandardFonts.TimesRoman),
		courier: await doc.embedFont(StandardFonts.Courier)
	};
	for (const src of pages) {
		const w = Number.isFinite(src.width) && src.width > 0 ? src.width : 612;
		const h = Number.isFinite(src.height) && src.height > 0 ? src.height : 792;
		const page = doc.addPage([w, h]);
		for (const el of src.elements) {
			await drawElement(doc, page, el, h, fonts, false);
		}
	}
	return new Uint8Array(await doc.save());
}
