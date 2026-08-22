/**
 * Client (screen) → SVG user-space mapping via getScreenCTM inverse.
 *
 * Used for pointer event coordinate conversion inside SVGs with viewBox,
 * preserveAspectRatio, or CSS transforms.
 */

export type Affine2d = { a: number; b: number; c: number; d: number; e: number; f: number };

export const DEFAULT_VIEWBOX = { width: 400, height: 400 };

function z(n: number): number {
	return n === 0 ? 0 : n;
}

/** Inverse of an SVG/CSS 2D affine matrix. Identity if the matrix is singular. */
export function invertAffine(m: Affine2d): Affine2d {
	const det = m.a * m.d - m.b * m.c;
	if (!det) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
	return {
		a: z(m.d / det),
		b: z(-m.b / det),
		c: z(-m.c / det),
		d: z(m.a / det),
		e: z((m.c * m.f - m.d * m.e) / det),
		f: z((m.b * m.e - m.a * m.f) / det)
	};
}

/** Map a client (screen) point through the inverse of `getScreenCTM()`. */
export function clientToSvgUser(
	ctm: Affine2d | null | undefined,
	clientX: number,
	clientY: number
): { x: number; y: number } {
	if (!ctm) return { x: clientX, y: clientY };
	const inv = invertAffine(ctm);
	return {
		x: inv.a * clientX + inv.c * clientY + inv.e,
		y: inv.b * clientX + inv.d * clientY + inv.f
	};
}

/**
 * Convert a pointer's client coords into the user space of `el`'s owner SVG.
 * Falls back to mapping the element's bounding box onto a viewBox.
 */
export function clientPointToOwnerSvg(
	el: SVGElement | null | undefined,
	clientX: number,
	clientY: number,
	viewBox: { width: number; height: number } = DEFAULT_VIEWBOX
): { x: number; y: number } {
	// An <svg> has a null ownerSVGElement; a <g> points at its parent svg.
	const svg = (el?.ownerSVGElement ?? el ?? null) as SVGGraphicsElement | null;
	const ctm = typeof svg?.getScreenCTM === 'function' ? svg.getScreenCTM() : null;
	if (ctm) return clientToSvgUser(ctm, clientX, clientY);

	const rect = svg?.getBoundingClientRect?.();
	if (!rect || !rect.width || !rect.height) return { x: clientX, y: clientY };
	return {
		x: ((clientX - rect.left) / rect.width) * viewBox.width,
		y: ((clientY - rect.top) / rect.height) * viewBox.height
	};
}
