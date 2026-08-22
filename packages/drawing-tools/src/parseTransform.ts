/**
 * SVG transform string parsing → affine matrix.
 *
 * Provides headless affine matrix arithmetic and SVG transform attribute parsing.
 */

export interface AffineMatrix {
	/** [a b c d e f] — SVG matrix order. x' = a*x + c*y + e; y' = b*x + d*y + f. */
	a: number;
	b: number;
	c: number;
	d: number;
	e: number;
	f: number;
}

export const AFFINE_IDENTITY: AffineMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Compose two affine matrices: `m1 * m2` (m2 is applied to points first). */
export function multiplyAffine(m1: AffineMatrix, m2: AffineMatrix): AffineMatrix {
	return {
		a: m1.a * m2.a + m1.c * m2.b,
		b: m1.b * m2.a + m1.d * m2.b,
		c: m1.a * m2.c + m1.c * m2.d,
		d: m1.b * m2.c + m1.d * m2.d,
		e: m1.a * m2.e + m1.c * m2.f + m1.e,
		f: m1.b * m2.e + m1.d * m2.f + m1.f,
	};
}

export function isAffineIdentity(m: AffineMatrix): boolean {
	return (
		m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0
	);
}

/**
 * Parse an SVG `transform` attribute string into an {@link AffineMatrix}.
 * Returns `null` for empty/identity transforms so callers can skip the work.
 *
 * Supports `translate(tx, ty)`, `scale(sx, sy)`, `matrix(a,b,c,d,e,f)`, and
 * `rotate(deg)` (with optional center, treated as rotate-then-translate).
 * Multiple transforms compose left-to-right (SVG order).
 */
export function parseSvgTransform(transform: string | undefined | null): AffineMatrix | null {
	if (!transform) return null;
	let result: AffineMatrix = { ...AFFINE_IDENTITY };
	const regex = /(translate|scale|matrix|rotate)\s*\(([^)]*)\)/gi;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(transform)) !== null) {
		const fn = match[1].toLowerCase();
		const args = match[2]
			.split(/[\s,]+/)
			.map(Number)
			.filter((n) => !Number.isNaN(n));
		let m: AffineMatrix;
		switch (fn) {
			case 'translate': {
				const tx = args[0] ?? 0;
				const ty = args[1] ?? 0;
				m = { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
				break;
			}
			case 'scale': {
				const sx = args[0] ?? 1;
				const sy = args.length > 1 ? args[1] : sx;
				m = { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
				break;
			}
			case 'matrix': {
				if (args.length < 6) continue;
				m = { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] };
				break;
			}
			case 'rotate': {
				const angle = ((args[0] ?? 0) * Math.PI) / 180;
				const cos = Math.cos(angle);
				const sin = Math.sin(angle);
				if (args.length >= 4) {
					// rotate(deg, cx, cy) = translate(cx,cy) * rotate * translate(-cx,-cy)
					const cx = args[1];
					const cy = args[2];
					const t1: AffineMatrix = { a: 1, b: 0, c: 0, d: 1, e: cx, f: cy };
					const r: AffineMatrix = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
					const t2: AffineMatrix = { a: 1, b: 0, c: 0, d: 1, e: -cx, f: -cy };
					m = multiplyAffine(multiplyAffine(t1, r), t2);
				} else {
					m = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
				}
				break;
			}
			default:
				continue;
		}
		result = multiplyAffine(result, m);
	}
	return isAffineIdentity(result) ? null : result;
}

/** Convert an {@link AffineMatrix} to a 6-element array `[a,b,c,d,e,f]`. */
export function affineToArray(m: AffineMatrix): [number, number, number, number, number, number] {
	return [m.a, m.b, m.c, m.d, m.e, m.f];
}
