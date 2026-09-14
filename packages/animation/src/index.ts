export type {
	AnimCanvas,
	AnimClip,
	AnimClipSnapshot,
	AnimDocView,
	AnimDocument,
	AnimFrame,
	AnimKeyframe,
	AnimPlayheadData,
	AnimWindowData,
	BindMode,
	ClipMediaKind,
	ClipSource,
	DocSource,
	VfsDocSource,
	MonitorDocSource,
	FsBackend,
	SketchFragment,
	SketchFragmentKind,
	SketchObjectKind,
	BoundClip,
	ClipOnBackend
} from './types.js';
export { isBoundClip, clipOnBackend } from './types.js';
export {
	BIND_MODES,
	CLIP_MEDIA_KINDS,
	DEFAULT_ANIM_CANVAS,
	SKETCH_FRAGMENT_KINDS,
	SKETCH_OBJECT_KINDS
} from './types.js';

export {
	AnimParseError,
	assertClipMatchesDoc,
	clipSpanMs,
	clipVisibleAt,
	isAudioClip,
	isVisualClip,
	parseAnimDocument,
	sameFsBackend,
	serializeAnimDocument,
	withDropKeyframes
} from './document.js';

export {
	documentRefs,
	findCycle,
	isProvenAcyclic,
	liveRefs,
	load,
	refKey,
	traverses,
	normalizeRelPath,
	vfsNodeIdFromKey,
	vfsRefKey,
	wouldCycle,
	type CycleResult,
	type DocRef,
	type RefLoad,
	type RefLoader,
	type WalkBudget
} from './refs.js';

export {
	DEFAULT_MAX_DEPTH,
	emptyContext,
	enter,
	refusedLinkState,
	rootContext,
	type EnterResult,
	type ResolveContext
} from './resolveContext.js';

export {
	assertFrozen,
	DEFAULT_MAX_BYTES_REF_CHARS,
	freezeDocument,
	frozenViolations,
	isFrozen,
	isFrozenSnapshot,
	NotFrozenError,
	type BytesResolver,
	type DocResolver,
	type FreezeBudget,
	type FreezeResult,
	type FrozenViolation
} from './frozen.js';

export {
	decideWrite,
	fingerprintBytes,
	fingerprintText,
	type WriteDecision
} from './bytesGate.js';

export { sampleClipFrame } from './sample.js';
export { applyAnimOp, type AnimOp } from './ops.js';

export { createCompositionClock, createPlayheadRegistry } from '@shared-packages/composition';
export type { ClockState, CompositionClock, PlayheadRegistry } from '@shared-packages/composition';
