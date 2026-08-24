import {
	apply,
	invert,
	isAtomic,
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
	const first = next.blocks[0];
	const selection = collapsed({ blockId: first.id, offset: 0 });
	return {
		page: next,
		selection,
		undo: [],
		redo: [],
		composing: false,
		blockFocus: isAtomic(first) ? first.id : undefined,
		justCommittedComposition: false
	};
}

export function blockFocusOf(page: KbPage, selection: Range): string | undefined {
	if (!isCollapsed(selection)) return undefined;
	const block = page.blocks.find((item) => item.id === selection.anchor.blockId);
	if (block && isAtomic(block)) return block.id;
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
			return prev;
		case 'split-block':
			return collapsed({ blockId: op.newId, offset: 0 });
		case 'merge-block': {
			const keep = pre.blocks.find((item) => item.id === op.keepId);
			const keepLen = keep ? plaintextOf(keep).length : 0;
			return collapsed({ blockId: op.keepId, offset: keepLen });
		}
		case 'insert-block':
			return collapsed({ blockId: op.block.id, offset: 0 });
		case 'delete-block': {
			const index = blockIndex(pre, op.id);
			const following = pre.blocks[index + 1];
			const previous = pre.blocks[index - 1];
			if (following && post.blocks.some((item) => item.id === following.id)) {
				return collapsed({ blockId: following.id, offset: 0 });
			}
			if (previous && post.blocks.some((item) => item.id === previous.id)) {
				const keep = post.blocks.find((item) => item.id === previous.id)!;
				return collapsed({ blockId: previous.id, offset: plaintextOf(keep).length });
			}
			const remaining = post.blocks[0];
			return collapsed({ blockId: remaining.id, offset: plaintextOf(remaining).length });
		}
		case 'move-block': {
			const current = prev.anchor.blockId === op.id ? prev : collapsed({ blockId: op.id, offset: 0 });
			return current;
		}
		case 'convert-block': {
			const block = post.blocks.find((item) => item.id === op.id);
			const len = block ? plaintextOf(block).length : 0;
			const offset = Math.min(prev.anchor.offset, len);
			return collapsed({ blockId: op.id, offset });
		}
		case 'set-code':
		case 'set-title':
		case 'set-children':
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
