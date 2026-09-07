import { describe, expect, it } from 'vitest';
import { escapedMenuBox } from './escapePaneClip.ts';

const viewport = { width: 1000, height: 800 };

describe('escapedMenuBox', () => {
	it('opens just below the trigger, left-aligned', () => {
		expect(
			escapedMenuBox({ left: 40, right: 66, bottom: 30 }, { width: 170, height: 120 }, viewport)
		).toEqual({ left: 40, top: 36, maxHeight: 784 });
	});

	it('clamps to the viewport when the trigger is near the right edge', () => {
		const box = escapedMenuBox(
			{ left: 900, right: 980, bottom: 30 },
			{ width: 268, height: 200 },
			viewport
		);
		expect(box.left).toBe(1000 - 268 - 8);
		expect(box.top).toBe(36);
	});

	it('end-aligns to the trigger right edge', () => {
		const box = escapedMenuBox(
			{ left: 700, right: 780, bottom: 30 },
			{ width: 280, height: 200 },
			viewport,
			{ align: 'end' }
		);
		expect(box.left).toBe(500);
	});

	it('does not place the menu above the viewport when it is taller than remaining space', () => {
		const box = escapedMenuBox(
			{ left: 20, right: 50, bottom: 20 },
			{ width: 268, height: 900 },
			{ width: 400, height: 360 }
		);
		expect(box.top).toBe(8);
		expect(box.maxHeight).toBe(344);
	});
});
