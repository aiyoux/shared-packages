export type {
	AnimClip,
	AnimClipSnapshot,
	AnimDocument,
	AnimFrame,
	AnimKeyframe,
	BindMode,
	ClipMediaKind,
	ClipSource,
	FsBackend,
	SketchFragment,
	SketchFragmentKind,
	SketchObjectKind
} from './types.js';
export {
	BIND_MODES,
	CLIP_MEDIA_KINDS,
	SKETCH_FRAGMENT_KINDS,
	SKETCH_OBJECT_KINDS
} from './types.js';

export {
	AnimParseError,
	assertClipMatchesDoc,
	clipNeedsV2,
	isAudioClip,
	isVisualClip,
	parseAnimDocument,
	sameFsBackend,
	serializeAnimDocument
} from './document.js';

export { sampleClipFrame } from './sample.js';

export { createCompositionClock } from '@shared-packages/composition';
export type { ClockState, CompositionClock } from '@shared-packages/composition';
