import { describe, it, expect } from 'vitest';
import { createTreeDndSession } from './session.js';

describe('treeDnd session', () => {
	it('start / target / stop', () => {
		const s = createTreeDndSession();
		expect(s.getState().active).toBe(false);
		s.startDrag(['a', 'b'], null);
		expect(s.getState().active).toBe(true);
		expect(s.getState().primaryId).toBe('a');
		s.setDropTarget('x', 'into');
		expect(s.getState().zone).toBe('into');
		s.clearDropTarget();
		expect(s.getState().targetId).toBeNull();
		s.stopDrag();
		expect(s.getState().active).toBe(false);
	});

	it('isolated instances (dual-pane)', () => {
		const a = createTreeDndSession();
		const b = createTreeDndSession();
		a.startDrag(['1'], null);
		expect(b.getState().active).toBe(false);
	});
});
