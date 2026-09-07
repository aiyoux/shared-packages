import { describe, expect, it } from 'vitest';
import { newLayoutId, resetLayoutIdsForTests } from '../pane-layout/tree.js';
import {
	appWindowBodyId,
	appWindowSlotId,
	nextAppWindowLayoutId,
	resetAppWindowLayoutIdsForTests
} from './leafHome.js';

describe('app-windows leafHome ids', () => {
	it('namespaces slot and body ids by layoutId so two mounts can share leaf ids', () => {
		expect(appWindowSlotId('files-1', 'left')).toBe('aw-files-1-slot-left');
		expect(appWindowSlotId('files-2', 'left')).toBe('aw-files-2-slot-left');
		expect(appWindowSlotId('files-1', 'left')).not.toBe(appWindowSlotId('files-2', 'left'));
		expect(appWindowBodyId('files-1', 'left')).not.toBe(appWindowBodyId('files-2', 'left'));
	});

	it('does not consume the pane-layout leaf id sequence', () => {
		resetLayoutIdsForTests();
		resetAppWindowLayoutIdsForTests();
		const a = nextAppWindowLayoutId('files');
		const b = nextAppWindowLayoutId('files');
		expect(a).toBe('files-1');
		expect(b).toBe('files-2');
		expect(newLayoutId('leaf')).toBe('leaf-1');
	});
});
