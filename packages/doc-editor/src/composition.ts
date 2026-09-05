import type { DocBody, KbPage, Op, Range } from '@shared-packages/doc-model';
import { deleteRangeOps, isCollapsed, orderedRange, textInsertPoint } from './range.js';
import type { EditorState } from './state.js';

export type CompositionSnapshot<TDoc extends DocBody = KbPage> = {
	page: TDoc;
	selection: Range;
};

export function snapshotComposition<TDoc extends DocBody>(
	state: EditorState<TDoc>,
	liveRange: Range
): CompositionSnapshot<TDoc> {
	return { page: state.page, selection: liveRange };
}

export function beginComposition<TDoc extends DocBody>(state: EditorState<TDoc>): EditorState<TDoc> {
	return { ...state, composing: true };
}

/**
 * IME freeze: while composing, never preventDefault, never dispatch, never re-project.
 * compositionend with empty data (Esc/cancel) re-projects the snapshot and does not insert.
 */
export function cancelComposition<TDoc extends DocBody>(
	state: EditorState<TDoc>
): EditorState<TDoc> {
	return { ...state, composing: false, justCommittedComposition: false };
}

export function commitComposition<TDoc extends DocBody>(
	state: EditorState<TDoc>,
	snapshot: CompositionSnapshot<TDoc>,
	data: string
): { state: EditorState<TDoc>; ops: Op[] } {
	if (!data) {
		return { state: cancelComposition(state), ops: [] };
	}
	const ops: Op[] = [];
	if (!isCollapsed(snapshot.selection)) {
		ops.push(...deleteRangeOps(snapshot.page, snapshot.selection));
	}
	const { start } = orderedRange(snapshot.page, snapshot.selection);
	const at = textInsertPoint(snapshot.page, start);
	if (at) ops.push({ kind: 'insert-text', at, text: data });
	return {
		state: { ...state, composing: false, justCommittedComposition: true },
		ops
	};
}

export function confirmedCompositionText(
	event: { data: string | null },
	domPlaintext: string | null,
	snapshotPlaintext: string
): string {
	if (event.data != null && event.data !== '') return event.data;
	if (event.data === '') return '';
	if (domPlaintext == null) return '';
	if (domPlaintext === snapshotPlaintext) return '';
	if (domPlaintext.startsWith(snapshotPlaintext)) return domPlaintext.slice(snapshotPlaintext.length);
	return domPlaintext;
}

export function shouldProject(state: EditorState): boolean {
	return !state.composing;
}

export function clearJustCommittedLater(cb: () => void): void {
	queueMicrotask(() => {
		setTimeout(cb, 0);
	});
}
