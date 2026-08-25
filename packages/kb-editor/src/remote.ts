import {
	applyRemote,
	dropUndoGroupsTouchedByRemote,
	mapRangeThroughOp,
	snapMappedPoint,
	type KbPage,
	type Op
} from '@shared-packages/kb-model';
import { clampRange, collapsed } from './range.js';
import { blockFocusOf, createEditorState, type EditorState } from './state.js';

function applyOneRemote(state: EditorState, op: Op): EditorState {
	const undo = dropUndoGroupsTouchedByRemote(state.undo, state.page, op);
	const redo = dropUndoGroupsTouchedByRemote(state.redo, state.page, op);
	const pre = state.page;
	const mapped = mapRangeThroughOp(pre, state.selection, op);
	const page = applyRemote(pre, op);
	if (page === pre) {
		return { ...state, undo, redo };
	}
	const selection = mapped
		? clampRange(page, mapped)
		: clampRange(page, collapsed(snapMappedPoint(pre, page, state.selection.head)));
	return {
		...state,
		page,
		selection,
		undo,
		redo,
		blockFocus: blockFocusOf(page, selection)
	};
}

/** Queue every remote op. IME freeze forbids apply/project/widgets. */
export function queueRemoteWhileComposing(state: EditorState, ops: Op[]): EditorState {
	if (ops.length === 0) return state;
	return { ...state, pendingRemote: [...(state.pendingRemote ?? []), ...ops] };
}

/**
 * Apply remotes without undo.push. Same-block local groups are dropped (D18).
 * While composing, queue ALL remotes (D14) — compositionend commits local first.
 */
export function applyRemoteOps(state: EditorState, ops: Op[]): EditorState {
	if (ops.length === 0) return state;
	if (state.composing) return queueRemoteWhileComposing(state, ops);
	let next = state.pendingRemote?.length ? flushPendingRemotes(state) : { ...state, pendingRemote: [] };
	for (const op of ops) next = applyOneRemote(next, op);
	return next;
}

/** Drain the IME queue after compositionend committed the snapshot insert. */
export function flushPendingRemotes(state: EditorState): EditorState {
	const queued = state.pendingRemote ?? [];
	if (queued.length === 0) return { ...state, pendingRemote: [] };
	let next: EditorState = { ...state, pendingRemote: [] };
	for (const op of queued) next = applyOneRemote(next, op);
	return next;
}

/** Nack/resync: replace the live page and clear undo/redo. */
export function replaceFromSnapshot(page: KbPage): EditorState {
	return { ...createEditorState(page), pendingRemote: [] };
}
