import {
	isAtomic,
	isTextLike,
	plaintextOf,
	type Mark,
	type Op,
	type Range
} from '@shared-packages/kb-model';
import { newBlockId } from './ids.js';
import { isCollapsed } from './range.js';
import { slashOps } from './slash.js';
import type { EditorState } from './state.js';
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
};

const DELETE_TYPES = new Set([
	'deleteContentBackward',
	'deleteContentForward',
	'deleteByCut',
	'deleteContent',
	'deleteByDrag'
]);

function formatOps(state: EditorState, live: Range, mark: Mark): Op[] {
	if (isCollapsed(live)) return [];
	return [{ kind: 'format-range', range: live, mark, on: true }];
}

function enterOps(state: EditorState, live: Range): Op[] {
	const point = live.anchor;
	if (!isCollapsed(live)) {
		return [
			{ kind: 'delete-range', range: live },
			...enterOps(
				{ ...state, selection: { anchor: live.anchor, head: live.anchor } },
				{ anchor: live.anchor, head: live.anchor }
			)
		];
	}
	const block = state.page.blocks.find((item) => item.id === point.blockId);
	if (!block) return [];
	if (isAtomic(block)) {
		return [
			{
				kind: 'insert-block',
				afterId: block.id,
				block: { id: newBlockId(), type: 'paragraph', content: [{ type: 'text', text: '', marks: [] }] }
			}
		];
	}
	if (block.type === 'code') {
		if (isCodeEmptyLastLine(block, point.offset)) {
			return [{ kind: 'split-block', at: point, newId: newBlockId() }];
		}
		return [{ kind: 'insert-text', at: point, text: '\n' }];
	}
	const text = plaintextOf(block);
	const slash = slashOps(block.id, text);
	if (slash) return slash;
	if (block.type === 'list_item' && text === '') {
		return [{ kind: 'convert-block', id: block.id, to: 'paragraph' }];
	}
	if (block.type === 'heading' && text === '') {
		return [{ kind: 'convert-block', id: block.id, to: 'paragraph' }];
	}
	if (block.type === 'heading' && point.offset === text.length) {
		return [
			{
				kind: 'insert-block',
				afterId: block.id,
				block: { id: newBlockId(), type: 'paragraph', content: [{ type: 'text', text: '', marks: [] }] }
			}
		];
	}
	return [{ kind: 'split-block', at: point, newId: newBlockId() }];
}

function deleteOps(state: EditorState, live: Range, inputType: string): Op[] {
	if (state.blockFocus) {
		return [{ kind: 'delete-block', id: state.blockFocus }];
	}
	const backward = inputType === 'deleteContentBackward';
	const forward =
		inputType === 'deleteContentForward' ||
		inputType === 'deleteContent' ||
		inputType === 'deleteByCut' ||
		inputType === 'deleteByDrag';
	if (!isCollapsed(live)) {
		return [{ kind: 'delete-range', range: live }];
	}
	const block = state.page.blocks.find((item) => item.id === live.anchor.blockId);
	if (!block) return [];
	if (isAtomic(block)) return [{ kind: 'delete-block', id: block.id }];
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

function insertTextOps(state: EditorState, live: Range, text: string): Op[] {
	if (!text) return [];
	const ops: Op[] = [];
	const at = live.anchor;
	if (!isCollapsed(live)) ops.push({ kind: 'delete-range', range: live });
	const block = state.page.blocks.find((item) => item.id === at.blockId);
	if (block && isAtomic(block)) {
		ops.push({
			kind: 'insert-block',
			afterId: block.id,
			block: {
				id: newBlockId(),
				type: 'paragraph',
				content: [{ type: 'text', text, marks: [] }]
			}
		});
		return ops;
	}
	if (text === ' ' && block && isTextLike(block) && isCollapsed(live)) {
		const slash = slashOps(block.id, plaintextOf(block));
		if (slash) return slash;
	}
	if (block && isTextLike(block) && text.includes('\n')) {
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
	ops.push({ kind: 'insert-text', at, text });
	return ops;
}

/**
 * Map beforeinput to ops.
 *
 * While composing: never preventDefault, never dispatch, never re-project.
 * justCommittedComposition swallows follow-up insertText / insertParagraph / insertLineBreak.
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

	if (type === 'insertParagraph' || type === 'insertLineBreak') {
		return { preventDefault: true, ops: enterOps(state, liveRange), freeze: false };
	}

	if (type === 'insertReplacementText') {
		const ops: Op[] = [];
		if (!isCollapsed(liveRange)) ops.push({ kind: 'delete-range', range: liveRange });
		if (event.data) ops.push({ kind: 'insert-text', at: liveRange.anchor, text: event.data });
		return { preventDefault: true, ops, freeze: false };
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

	if (type === 'insertFromPaste' || type === 'insertFromDrop') {
		return { preventDefault: true, ops: [], freeze: false };
	}

	return { preventDefault: true, ops: [], freeze: false };
}
