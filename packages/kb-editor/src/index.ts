export { mapBeforeInput, type BeforeInputEvent, type BeforeInputResult } from './beforeinput.js';
export {
	copyPayload,
	cutOps,
	KB_CLIPBOARD_MIME,
	parseSlice,
	pasteOps,
	serializeSlice,
	remapBlock,
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
export {
	COLLAB_SEL_ATTR,
	COLLAB_WIDGET_ATTR,
	paintCarets,
	stripCollabWidgets,
	stripCollabWidgetsHtml,
	type RemoteCaret
} from './decorations.js';
export { dropAfterId, dropTarget, dropWhere, gutterOrder, handleHeights, overlayBoxes } from './gutter.js';
export { allowlistedHref, allowlistedSrc } from './href.js';
export { newBlockId } from './ids.js';
export { mapKeydown, type KeyEvent, type KeymapResult } from './keymap.js';
export {
	BLOCK_ID_ATTR,
	BLOCK_TYPE_ATTR,
	COL_ATTR,
	DEPTH_ATTR,
	PARENT_ID_ATTR,
	project,
	renderBlock,
	syncView,
	type ProjectOpts
} from './project.js';
export {
	blockIndex,
	clampRange,
	collapsed,
	deleteRangeOps,
	isCollapsed,
	orderedRange,
	textInsertPoint
} from './range.js';
export {
	caretIn,
	pointFromDom,
	plaintextFromDom,
	rangeFromEndpoints,
	rangeFromInputEvent,
	rangeFromSelection,
	restoreSelection,
	textNodes
} from './selection.js';
export { matchSlash, slashOps } from './slash.js';
export {
	applyRemoteOps,
	flushPendingRemotes,
	queueRemoteWhileComposing,
	replaceFromSnapshot
} from './remote.js';
export {
	cellCoords,
	defaultTable,
	enterCellOps,
	tabOps,
	tableRect,
	type CellCoords,
	type TableNav
} from './table.js';
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
	isContainer,
	isNonTextual,
	isTableStructure,
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
