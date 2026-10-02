/**
 * Canvas paint for one vector path element, shared by the pdf-layer and
 * svg-layer raster painters in svg-sketcher (their fill+stroke branches were
 * verbatim copies). Typed structurally so both element unions satisfy it.
 */
export type PaintablePathElement = {
    d: string;
    fill: string;
    stroke: string;
    strokeWidth: number;
    fillRule?: 'nonzero' | 'evenodd';
};

export function paintPathElement(
    ctx: CanvasRenderingContext2D,
    el: PaintablePathElement
): void {
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
}