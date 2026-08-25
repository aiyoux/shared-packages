import {
	apply,
	documentOrder,
	findBlock,
	invert,
	isNonTextual,
	normalizePage,
	plaintextOf,
	type KbPage,
	type Op,
	type Range
} from '@shared-packages/kb-model';
import { blockIndex, clampRange, collapsed, isCollapsed } from './range.js';

export const UNDO_CAP = 200;

export type EditorState = {
	page: KbPage;
	selection: Range;
	undo: Op[][];
	redo: Op[][];
	composing: boolean;
	blockFocus?: string;
	justCommittedComposition?: boolean;
};

export function createEditorState(page: KbPage): EditorState {
	const next = normalizePage(page);
	const first = documentOrder(next)[0];
	if (!first) throw new Error('empty page');
	const selection = collapsed({ blockId: first.id, offset: 0 });
	return {
		page: next,
		selection,
		undo: [],
		redo: [],
		composing: false,
		blockFocus: isNonTextual(first) ? first.id : undefined,
		justCommittedComposition: false
	};
}

export function blockFocusOf(page: KbPage, selection: Range): string | undefined {
	if (!isCollapsed(selection)) return undefined;
	const block = findBlock(page, selection.anchor.blockId);
	if (block && isNonTextual(block)) return block.id;
	return undefined;
}

function selectionAfter(pre: KbPage, post: KbPage, op: Op, prev: Range): Range {
	switch (op.kind) {
		case 'insert-text':
			return collapsed({
				blockId: op.at.blockId,
				offset: op.at.offset + op.text.length
			});
		case 'delete-range': {
			const ai = blockIndex(pre, op.range.anchor.blockId);
			const hi = blockIndex(pre, op.range.head.blockId);
			const start =
				ai < hi || (ai === hi && op.range.anchor.offset <= op.range.head.offset)
					? op.range.anchor
					: op.range.head;
			return collapsed(start);
		}
		case 'format-range':
			return op.range;
		case 'split-block':
			return collapsed({ blockId: op.newId, offset: 0 });
		case 'merge-block': {
			const keep = findBlock(pre, op.keepId);
			const keepLen = keep ? plaintextOf(keep).length : 0;
			return collapsed({ blockId: op.keepId, offset: keepLen });
		}
		case 'insert-block': {
			if (op.block.type === 'table') {
				const cell = op.block.children[0]?.children[0];
				if (cell) return collapsed({ blockId: cell.id, offset: 0 });
			}
			return collapsed({ blockId: op.block.id, offset: 0 });
		}
		case 'insert-table-row': {
			const col = (op as typeof op & { focusCol?: number }).focusCol ?? 0;
			const dest = op.row.children[Math.min(Math.max(0, col), Math.max(0, op.row.children.length - 1))];
			if (dest) return collapsed({ blockId: dest.id, offset: 0 });
			return collapsed({ blockId: op.row.id, offset: 0 });
		}
		case 'insert-table-column': {
			const cell = op.cells[0];
			if (cell) return collapsed({ blockId: cell.id, offset: 0 });
			return prev;
		}
		case 'delete-table-row': {
			const table = findBlock(post, op.tableId);
			if (table?.type === 'table') {
				const cell = table.children[0]?.children[0];
				if (cell) return collapsed({ blockId: cell.id, offset: 0 });
				return collapsed({ blockId: table.id, offset: 0 });
			}
			const remaining = documentOrder(post)[0];
			return collapsed({ blockId: remaining.id, offset: plaintextOf(remaining).length });
		}
		case 'delete-table-column': {
			if (findBlock(post, prev.anchor.blockId)) {
				return clampRange(post, collapsed(prev.anchor));
			}
			const table = findBlock(post, op.tableId);
			if (table?.type === 'table') {
				const row = table.children[0];
				const cell = row?.children[Math.min(op.index, Math.max(0, (row?.children.length ?? 1) - 1))];
				if (cell) return collapsed({ blockId: cell.id, offset: 0 });
				return collapsed({ blockId: table.id, offset: 0 });
			}
			return prev;
		}
		case 'delete-block': {
			const order = documentOrder(pre);
			const index = blockIndex(pre, op.id);
			let following: (typeof order)[number] | undefined;
			for (let i = index + 1; i < order.length; i++) {
				if (findBlock(post, order[i].id)) {
					following = order[i];
					break;
				}
			}
			if (following) {
				return collapsed({ blockId: following.id, offset: 0 });
			}
			let previous: (typeof order)[number] | undefined;
			for (let i = index - 1; i >= 0; i--) {
				if (findBlock(post, order[i].id)) {
					previous = order[i];
					break;
				}
			}
			if (previous) {
				const keep = findBlock(post, previous.id)!;
				return collapsed({ blockId: previous.id, offset: plaintextOf(keep).length });
			}
			const remaining = documentOrder(post)[0];
			return collapsed({ blockId: remaining.id, offset: plaintextOf(remaining).length });
		}
		case 'move-block': {
			const current = prev.anchor.blockId === op.id ? prev : collapsed({ blockId: op.id, offset: 0 });
			return current;
		}
		case 'convert-block': {
			const block = findBlock(post, op.id);
			const len = block ? plaintextOf(block).length : 0;
			const offset = Math.min(prev.anchor.offset, len);
			return collapsed({ blockId: op.id, offset });
		}
		case 'set-code':
		case 'set-title':
		case 'set-children':
		case 'set-toggle':
			return prev;
		default: {
			const _never: never = op;
			void _never;
			return prev;
		}
	}
}

function pushUndo(state: EditorState, group: Op[]): Pick<EditorState, 'undo' | 'redo'> {
	if (group.length === 0) return { undo: state.undo, redo: state.redo };
	return {
		undo: [...state.undo, group].slice(-UNDO_CAP),
		redo: []
	};
}

export function dispatch(state: EditorState, op: Op): EditorState {
	const inverse = op.kind === 'set-children' ? [] : invert(state.page, op);
	const page = apply(state.page, op);
	const selection = clampRange(page, selectionAfter(state.page, page, op, state.selection));
	const stack = op.kind === 'set-children' ? { undo: state.undo, redo: state.redo } : pushUndo(state, inverse);
	return {
		...state,
		page,
		selection,
		...stack,
		composing: false,
		blockFocus: blockFocusOf(page, selection)
	};
}

export function dispatchMany(state: EditorState, ops: Op[]): EditorState {
	if (ops.length === 0) return state;
	if (ops.length === 1) return dispatch(state, ops[0]);

	let page = state.page;
	let selection = state.selection;
	const inverseGroups: Op[][] = [];
	let touchUndo = false;
	for (const op of ops) {
		if (op.kind !== 'set-children') {
			inverseGroups.push(invert(page, op));
			touchUndo = true;
		}
		const next = apply(page, op);
		selection = selectionAfter(page, next, op, selection);
		page = next;
	}
	selection = clampRange(page, selection);
	const group = inverseGroups.reverse().flat();
	const stack = touchUndo ? pushUndo(state, group) : { undo: state.undo, redo: state.redo };
	return {
		...state,
		page,
		selection,
		...stack,
		composing: false,
		blockFocus: blockFocusOf(page, selection)
	};
}

export function undo(state: EditorState): EditorState {
	if (state.composing) return state;
	const group = state.undo[state.undo.length - 1];
	if (!group) return state;
	let page = state.page;
	let selection = state.selection;
	const redoGroup: Op[] = [];
	for (const op of group) {
		redoGroup.push(...invert(page, op));
		const next = apply(page, op);
		selection = selectionAfter(page, next, op, selection);
		page = next;
	}
	selection = clampRange(page, selection);
	return {
		...state,
		page,
		selection,
		undo: state.undo.slice(0, -1),
		redo: [...state.redo, redoGroup].slice(-UNDO_CAP),
		blockFocus: blockFocusOf(page, selection)
	};
}

export function redo(state: EditorState): EditorState {
	if (state.composing) return state;
	const group = state.redo[state.redo.length - 1];
	if (!group) return state;
	let page = state.page;
	let selection = state.selection;
	const undoGroup: Op[] = [];
	for (const op of group) {
		undoGroup.push(...invert(page, op));
		const next = apply(page, op);
		selection = selectionAfter(page, next, op, selection);
		page = next;
	}
	selection = clampRange(page, selection);
	return {
		...state,
		page,
		selection,
		undo: [...state.undo, undoGroup].slice(-UNDO_CAP),
		redo: state.redo.slice(0, -1),
		blockFocus: blockFocusOf(page, selection)
	};
}

export function setComposing(state: EditorState, composing: boolean): EditorState {
	return { ...state, composing };
}

export function setJustCommittedComposition(state: EditorState, value: boolean): EditorState {
	return { ...state, justCommittedComposition: value };
}

export function setSelection(state: EditorState, selection: Range): EditorState {
	const next = clampRange(state.page, selection);
	return { ...state, selection: next, blockFocus: blockFocusOf(state.page, next) };
}

/** Parent onDispatch handler: one undo group even when the editor emits Op[]. */
export function applyEditorOps(state: EditorState, op: Op | Op[]): EditorState {
	return Array.isArray(op) ? dispatchMany(state, op) : dispatch(state, op);
}
