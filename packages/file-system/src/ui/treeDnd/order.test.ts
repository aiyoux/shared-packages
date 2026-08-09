import { describe, it, expect } from 'vitest';
import { calculateMidOrder, needsRebalance, rebalanceOrders, ORDER_STEP } from './order.js';

describe('treeDnd order', () => {
	it('calculateMidOrder null,null → 0', () => {
		expect(calculateMidOrder(null, null)).toBe(0);
	});

	it('prepend / append use STEP', () => {
		expect(calculateMidOrder(null, 0)).toBe(-ORDER_STEP);
		expect(calculateMidOrder(0, null)).toBe(ORDER_STEP);
	});

	it('average between two', () => {
		expect(calculateMidOrder(0, ORDER_STEP)).toBe(ORDER_STEP / 2);
	});

	it('needsRebalance when collapsed', () => {
		expect(needsRebalance(5, 5, 10)).toBe(true);
		expect(needsRebalance(7.5, 0, ORDER_STEP)).toBe(false);
	});

	it('rebalanceOrders i*STEP', () => {
		expect(rebalanceOrders(3)).toEqual([0, ORDER_STEP, ORDER_STEP * 2]);
	});
});
