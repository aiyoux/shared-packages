import {
	apply,
	findBlock,
	isNonTextual,
	isTableStructure,
	isTextLike,
	plaintextOf,
	type Mark,
	type Op,
	type Point,
	type Range
} from '@shared-packages/kb-model';
import { newBlockId } from './ids.js';
import { clampPoint, collapsed, deleteRangeOps, isCollapsed, orderedRange, parentIdFor } from './range.js';
import { slashOps } from './slash.js';
import type { EditorState } from './state.js';
import { afterTableId, cellCoords, cellPlaintext, deleteRowOps, enterCellOps } from './table.js';
import { backspaceAtStartOps, deleteAtEndOps, expandCaretToUnit, isCodeEmptyLastLine } from './units.js';

export type BeforeInputEvent = {
	inputType: string;
	data: string | null;
	isComposing?: boolean;
};

export type BeforeInputResult = {
	preventDefault: boolean;
	ops: Op[];
	freeze: boolean;
	history?: 'undo' | 'redo';
	selection?: Range;
};

const DELETE_TYPES = new Set([
	'deleteContentBackward',
	'deleteContentForward',
	'deleteContent',
	'deleteByDrag'
]);

function emptyParagraph(id: string) {
	return { id, type: 'paragraph' as const, content: [{ type: 'text' as const, text: '', marks: [] }] };
}

/** Delete a non-collapsed range first, then compute follow-up ops on the post-delete page at document-order start. */
function withDeletedSelection(
	state: EditorState,
	live: Range
): { state: EditorState; at: Point; prefix: Op[] } {
	if (isCollapsed(live)) {
		return { state, at: live.anchor, prefix: [] };
	}
	const prefix = deleteRangeOps(state.page, live);
	if (prefix.length === 0) {
		return { state, at: clampPoint(state.page, live.anchor), prefix: [] };
	}
	const { start } = orderedRange(state.page, live);
	const page = apply(state.page, prefix[0]);
	const at = clampPoint(page, start);
	return {
		state: { ...state, page, selection: collapsed(at), blockFocus: undefined },
		at,
		prefix
	};
}

function formatOps(_state: EditorState, live: Range, mark: Mark): Op[] {
	if (isCollapsed(live)) return [];
	return [{ kind: 'format-range', range: live, mark, on: true }];
}

function insertAfter(page: EditorState['page'], afterId: string, block: ReturnType<typeof emptyParagraph>): Op {
	return { kind: 'insert-block', afterId, parentId: parentIdFor(page, afterId), block };
}

function enterAtCaret(state: EditorState, point: Point): Op[] {
	const block = findBlock(state.page, point.blockId);
	if (!block) return [];
	if (block.type === 'table_cell') {
		return enterCellOps(state.page, collapsed(point))?.ops ?? [];
	}
	if (isTableStructure(block)) {
		const afterId = afterTableId(state.page, block.id);
		if (!afterId) return [];
		return [{ kind: 'insert-block', afterId, parentId: null, block: emptyParagraph(newBlockId()) }];
	}
	if (isNonTextual(block)) {
		return [insertAfter(state.page, block.id, emptyParagraph(newBlockId()))];
	}
	if (block.type === 'code') {
		if (isCodeEmptyLastLine(block, point.offset)) {
			return [{ kind: 'split-block', at: point, newId: newBlockId() }];
		}
		return [{ kind: 'insert-text', at: point, text: '\n' }];
	}
	const text = plaintextOf(block);
	const slash = slashOps(block.id, text, state.page);
	if (slash) return slash;
	if (block.type === 'list_item' && text === '') {
		return [{ kind: 'convert-block', id: block.id, to: 'paragraph' }];
	}
	if (block.type === 'heading' && text === '') {
		return [{ kind: 'convert-block', id: block.id, to: 'paragraph' }];
	}
	if (block.type === 'heading' && point.offset === text.length) {
		return [insertAfter(state.page, block.id, emptyParagraph(newBlockId()))];
	}
	return [{ kind: 'split-block', at: point, newId: newBlockId() }];
}

function enterOps(state: EditorState, live: Range): { ops: Op[]; selection?: Range } {
	if (cellCoords(state.page, orderedRange(state.page, live).start.blockId)) {
		const nav = enterCellOps(state.page, live);
		if (nav) return nav;
	}
	const { state: next, at, prefix } = withDeletedSelection(state, live);
	if (cellCoords(next.page, at.blockId)) {
		const nav = enterCellOps(next.page, collapsed(at));
		if (nav) return { ops: [...prefix, ...nav.ops], selection: nav.selection };
	}
	return { ops: [...prefix, ...enterAtCaret(next, at)] };
}

/**
 * Shift+Enter: insert '\n' inside the block (hard break). null → caller falls
 * back to Enter semantics (tables/atomic blocks cannot host a break).
 */
export function hardBreakOps(
	state: EditorState,
	live: Range
): { ops: Op[]; selection?: Range } | null {
	const { state: next, at, prefix } = withDeletedSelection(state, live);
	const block = findBlock(next.page, at.blockId);
	if (!block) return null;
	if (isTableStructure(block) || isNonTextual(block)) return null;
	return { ops: [...prefix, { kind: 'insert-text', at, text: '\n' }] };
}

function deleteOps(state: EditorState, live: Range, inputType: string): Op[] {
	if (state.blockFocus && isCollapsed(live) && live.anchor.blockId === state.blockFocus) {
		const focused = findBlock(state.page, state.blockFocus);
		if (focused?.type === 'table_row') return deleteRowOps(state.page, focused.id);
		return [{ kind: 'delete-block', id: state.blockFocus }];
	}
	const backward = inputType === 'deleteContentBackward';
	const forward =
		inputType === 'deleteContentForward' ||
		inputType === 'deleteContent' ||
		inputType === 'deleteByDrag';
	if (!isCollapsed(live)) {
		return deleteRangeOps(state.page, live);
	}
	const block = findBlock(state.page, live.anchor.blockId);
	if (!block) return [];
	if (isNonTextual(block)) return [{ kind: 'delete-block', id: block.id }];
	if (backward) {
		if (live.anchor.offset === 0) return backspaceAtStartOps(state.page, block.id);
		const unit = expandCaretToUnit(state.page, live, 'backward');
		return unit ? [{ kind: 'delete-range', range: unit }] : [];
	}
	if (forward) {
		if (live.anchor.offset >= plaintextOf(block).length) return deleteAtEndOps(state.page, block.id);
		const unit = expandCaretToUnit(state.page, live, 'forward');
		return unit ? [{ kind: 'delete-range', range: unit }] : [];
	}
	return [];
}

function insertAtCaret(state: EditorState, at: Point, text: string): Op[] {
	if (!text) return [];
	const block = findBlock(state.page, at.blockId);
	if (!block) return [];
	if (isTableStructure(block)) {
		const afterId = afterTableId(state.page, block.id);
		if (!afterId) return [];
		return [
			{
				kind: 'insert-block',
				afterId,
				parentId: null,
				block: {
					id: newBlockId(),
					type: 'paragraph',
					content: [{ type: 'text', text: cellPlaintext(text), marks: [] }]
				}
			}
		];
	}
	if (isNonTextual(block)) {
		return [
			insertAfter(state.page, block.id, {
				id: newBlockId(),
				type: 'paragraph',
				content: [{ type: 'text', text, marks: [] }]
			})
		];
	}
	if (block.type === 'table_cell') {
		if (text === ' ') {
			const slash = slashOps(block.id, plaintextOf(block), state.page);
			if (slash) return slash;
		}
		const one = cellPlaintext(text);
		if (!one) return [];
		return [{ kind: 'insert-text', at, text: one }];
	}
	if (text === ' ' && block && isTextLike(block)) {
		const slash = slashOps(block.id, plaintextOf(block), state.page);
		if (slash) return slash;
	}
	if (block && isTextLike(block) && text.includes('\n')) {
		const ops: Op[] = [];
		const parts = text.split('\n');
		let blockId = at.blockId;
		let offset = at.offset;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			if (part) {
				ops.push({ kind: 'insert-text', at: { blockId, offset }, text: part });
				offset += part.length;
			}
			if (i < parts.length - 1) {
				const newId = newBlockId();
				ops.push({ kind: 'split-block', at: { blockId, offset }, newId });
				blockId = newId;
				offset = 0;
			}
		}
		return ops;
	}
	return [{ kind: 'insert-text', at, text }];
}

function insertTextOps(state: EditorState, live: Range, text: string): Op[] {
	if (!text) return [];
	const { state: next, at, prefix } = withDeletedSelection(state, live);
	return [...prefix, ...insertAtCaret(next, at, text)];
}

/**
 * Map beforeinput to ops.
 *
 * While composing: never preventDefault, never dispatch, never re-project.
 * justCommittedComposition swallows follow-up insertText / insertParagraph / insertLineBreak.
 * deleteByCut / insertFromPaste / insertFromDrop: preventDefault only; clipboard/drop handlers own the ops.
 */
export function mapBeforeInput(
	state: EditorState,
	event: BeforeInputEvent,
	liveRange: Range
): BeforeInputResult {
	if (state.composing || event.isComposing) {
		return { preventDefault: false, ops: [], freeze: true };
	}

	const type = event.inputType;
	if (state.justCommittedComposition) {
		if (type === 'insertText' || type === 'insertParagraph' || type === 'insertLineBreak') {
			return { preventDefault: true, ops: [], freeze: false };
		}
	}

	if (type === 'insertCompositionText') {
		return { preventDefault: false, ops: [], freeze: true };
	}

	if (type === 'insertText') {
		return { preventDefault: true, ops: insertTextOps(state, liveRange, event.data ?? ''), freeze: false };
	}

	if (type === 'insertParagraph') {
		const entered = enterOps(state, liveRange);
		return { preventDefault: true, ops: entered.ops, freeze: false, selection: entered.selection };
	}
	if (type === 'insertLineBreak') {
		const entered = hardBreakOps(state, liveRange) ?? enterOps(state, liveRange);
		return { preventDefault: true, ops: entered.ops, freeze: false, selection: entered.selection };
	}

	if (type === 'insertReplacementText') {
		const { state: next, at, prefix } = withDeletedSelection(state, liveRange);
		const insert = event.data ? insertAtCaret(next, at, event.data) : [];
		return { preventDefault: true, ops: [...prefix, ...insert], freeze: false };
	}

	if (type === 'deleteByCut' || type === 'insertFromPaste' || type === 'insertFromDrop') {
		return { preventDefault: true, ops: [], freeze: false };
	}

	if (DELETE_TYPES.has(type)) {
		return { preventDefault: true, ops: deleteOps(state, liveRange, type), freeze: false };
	}

	if (type === 'formatBold') {
		return { preventDefault: true, ops: formatOps(state, liveRange, { type: 'bold' }), freeze: false };
	}
	if (type === 'formatItalic') {
		return { preventDefault: true, ops: formatOps(state, liveRange, { type: 'italic' }), freeze: false };
	}

	if (type === 'historyUndo') {
		return { preventDefault: true, ops: [], freeze: false, history: 'undo' };
	}
	if (type === 'historyRedo') {
		return { preventDefault: true, ops: [], freeze: false, history: 'redo' };
	}

	return { preventDefault: true, ops: [], freeze: false };
}
