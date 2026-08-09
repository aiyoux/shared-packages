/**
 * Per-FileExplorer drag session (not module-global — dual-pane safe).
 */

import type { DropZone } from './zones.js';

export type TreeDndSessionState = {
	dragIds: string[];
	/** Primary drag id (for single-row UX) */
	primaryId: string | null;
	sourceParentId: string | null;
	targetId: string | null;
	zone: DropZone | null;
	active: boolean;
};

export type TreeDndSession = {
	getState: () => TreeDndSessionState;
	startDrag: (ids: string[], sourceParentId: string | null) => void;
	setDropTarget: (targetId: string | null, zone: DropZone | null) => void;
	clearDropTarget: () => void;
	stopDrag: () => void;
};

export function createTreeDndSession(): TreeDndSession {
	let state: TreeDndSessionState = {
		dragIds: [],
		primaryId: null,
		sourceParentId: null,
		targetId: null,
		zone: null,
		active: false
	};

	return {
		getState: () => state,
		startDrag(ids, sourceParentId) {
			const clean = ids.filter(Boolean);
			state = {
				dragIds: clean,
				primaryId: clean[0] ?? null,
				sourceParentId,
				targetId: null,
				zone: null,
				active: clean.length > 0
			};
		},
		setDropTarget(targetId, zone) {
			if (!state.active) return;
			state = { ...state, targetId, zone };
		},
		clearDropTarget() {
			state = { ...state, targetId: null, zone: null };
		},
		stopDrag() {
			state = {
				dragIds: [],
				primaryId: null,
				sourceParentId: null,
				targetId: null,
				zone: null,
				active: false
			};
		}
	};
}
