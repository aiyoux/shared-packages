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

export { sampleClipFrame } from './sample.js';

export { createCompositionClock, createPlayheadRegistry } from '@shared-packages/composition';
export type { ClockState, CompositionClock, PlayheadRegistry } from '@shared-packages/composition';
