import type { PdfIrElement, PdfTransform } from './types.js';

function applyTransform(ctx: CanvasRenderingContext2D, t?: PdfTransform) {
	if (!t) return;
	if (t.x || t.y) ctx.translate(t.x, t.y ?? 0);
	if (t.rotation) ctx.rotate(t.rotation);
	if (t.sx != null || t.sy != null) ctx.scale(t.sx ?? 1, t.sy ?? 1);
}

function paintOne(ctx: CanvasRenderingContext2D, el: PdfIrElement) {
	if (el.hidden) return;
	ctx.save();
	applyTransform(ctx, el.transform);
	if ('opacity' in el && el.opacity != null && el.opacity !== 1) {
		ctx.globalAlpha *= el.opacity;
	}
	switch (el.type) {
		case 'text': {
			if (el.d) {
				const path = new Path2D(el.d);
				ctx.fillStyle = el.fill;
				ctx.fill(path);
			} else {
				ctx.fillStyle = el.fill;
				ctx.font = `${el.fontSize}px sans-serif`;
				ctx.textBaseline = 'top';
				ctx.fillText(el.str, el.x, el.y);
			}
			break;
		}
		case 'path': {
			const path = new Path2D(el.d);
			if (el.fill && el.fill !== 'none') {
				ctx.fillStyle = el.fill;
				ctx.fill(path, el.fillRule === 'evenodd' ? 'evenodd' : 'nonzero');
			}
			if (el.stroke && el.stroke !== 'none' && el.strokeWidth > 0) {
				ctx.strokeStyle = el.stroke;
				ctx.lineWidth = el.strokeWidth;
				ctx.stroke(path);
			}
			break;
		}
		case 'group':
			for (const child of el.children) paintOne(ctx, child);
			break;
		case 'image':
		case 'chip':
			break;
	}
	ctx.restore();
}

export function paintIr(ctx: CanvasRenderingContext2D, elements: PdfIrElement[]): void {
	for (const el of elements) paintOne(ctx, el);
}
