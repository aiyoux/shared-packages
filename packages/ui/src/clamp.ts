/**
 * Clamp `v` into `[lo, hi]`. Assumes lo <= hi; callers with only a
 * lower bound that must survive an inverted hi keep a local variant
 * (workspacePlacement's floater clamps do).
 */
export function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}