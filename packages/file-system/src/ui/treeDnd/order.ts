/**
 * Fractional mid-order for sibling reordering (ported from modular-app item-tree order.ts).
 * Used for drag-and-drop reordering without rewriting every sibling each drop.
 */

const STEP = 16384;
const EPSILON = 1e-9;

/**
 * Midpoint between two sibling order values.
 * - both null → 0
 * - before null → after - STEP (prepend)
 * - after null → before + STEP (append)
 * - both set → average
 */
export function calculateMidOrder(beforeOrder: number | null, afterOrder: number | null): number {
	if (beforeOrder === null && afterOrder === null) return 0;
	if (beforeOrder === null && afterOrder !== null) return afterOrder - STEP;
	if (beforeOrder !== null && afterOrder === null) return beforeOrder + STEP;
	if (beforeOrder !== null && afterOrder !== null) {
		return (beforeOrder + afterOrder) / 2;
	}
	return 0;
}

/** True when mid collapsed onto an endpoint or gap is too small (need rebalance). */
export function needsRebalance(
	mid: number,
	beforeOrder: number | null,
	afterOrder: number | null
): boolean {
	if (beforeOrder !== null && Math.abs(mid - beforeOrder) < EPSILON) return true;
	if (afterOrder !== null && Math.abs(mid - afterOrder) < EPSILON) return true;
	if (beforeOrder !== null && afterOrder !== null && Math.abs(afterOrder - beforeOrder) < EPSILON) {
		return true;
	}
	return false;
}

/** Full sibling reindex: i * STEP (collapse-only policy). */
export function rebalanceOrders(count: number): number[] {
	const out: number[] = [];
	for (let i = 0; i < count; i++) out.push(i * STEP);
	return out;
}

export const ORDER_STEP = STEP;
