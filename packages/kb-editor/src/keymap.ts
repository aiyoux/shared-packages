import type { Mark, Op, Range } from '@shared-packages/kb-model';
import { isCollapsed } from './range.js';
import type { EditorState } from './state.js';

export type KeyEvent = {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
};

export type KeymapResult = {
	preventDefault: boolean;
	ops: Op[];
	history?: 'undo' | 'redo';
};

function formatOp(live: Range, mark: Mark): Op[] {
	if (isCollapsed(live)) return [];
	return [{ kind: 'format-range', range: live, mark, on: true }];
}

/** Keydown is a no-op while composing (do not preventDefault). Enter/Backspace are beforeinput-only. */
export function mapKeydown(state: EditorState, event: KeyEvent, live: Range): KeymapResult {
	if (state.composing) return { preventDefault: false, ops: [] };
	const mod = event.metaKey || event.ctrlKey;
	if (!mod) return { preventDefault: false, ops: [] };
	const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
	if (key === 'z' && event.shiftKey) return { preventDefault: true, ops: [], history: 'redo' };
	if (key === 'Z') return { preventDefault: true, ops: [], history: 'redo' };
	if (key === 'z') return { preventDefault: true, ops: [], history: 'undo' };
	if (key === 'y') return { preventDefault: true, ops: [], history: 'redo' };
	if (key === 'b') return { preventDefault: true, ops: formatOp(live, { type: 'bold' }) };
	if (key === 'i') return { preventDefault: true, ops: formatOp(live, { type: 'italic' }) };
	return { preventDefault: false, ops: [] };
}
