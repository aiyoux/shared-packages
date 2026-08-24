export { mapBeforeInput, type BeforeInputEvent, type BeforeInputResult } from './beforeinput.js';
export {
	copyPayload,
	cutOps,
	KB_CLIPBOARD_MIME,
	parseSlice,
	pasteOps,
	serializeSlice,
	sliceBlocks,
	slicePlaintext,
	stripHtml,
	type KbSlice
} from './clipboard.js';
export {
	beginComposition,
	cancelComposition,
	clearJustCommittedLater,
	commitComposition,
	confirmedCompositionText,
	shouldProject,
	snapshotComposition,
	type CompositionSnapshot
} from './composition.js';
export { dropAfterId, dropWhere } from './gutter.js';
export { allowlistedHref, allowlistedSrc } from './href.js';
export { newBlockId } from './ids.js';
export { mapKeydown, type KeyEvent, type KeymapResult } from './keymap.js';
export { BLOCK_ID_ATTR, BLOCK_TYPE_ATTR, project, renderBlock, syncView } from './project.js';
export {
	blockIndex,
	clampRange,
	collapsed,
	isCollapsed,
	orderedRange
} from './range.js';
export {
	caretIn,
	pointFromDom,
	rangeFromEndpoints,
	rangeFromInputEvent,
	rangeFromSelection,
	restoreSelection
} from './selection.js';
export { matchSlash, slashOps } from './slash.js';
export {
	applyEditorOps,
	blockFocusOf,
	createEditorState,
	dispatch,
	dispatchMany,
	redo,
	setComposing,
	setJustCommittedComposition,
	setSelection,
	undo,
	UNDO_CAP,
	type EditorState
} from './state.js';

export {
	apply,
	applyMany,
	createEmptyPage,
	documentOrder,
	findBlock,
	invert,
	isAtomic,
	isTextLike,
	KB_FORMAT,
	KB_SCHEMA_VERSION,
	normalizePage,
	parentOf,
	plaintext,
	plaintextOf,
	visibleOrder,
	type Block,
	type Inline,
	type KbPage,
	type Mark,
	type Op,
	type Point,
	type Range
} from '@shared-packages/kb-model';
