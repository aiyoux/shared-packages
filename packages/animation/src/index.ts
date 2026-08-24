export type {
	AnimClip,
	AnimClipSnapshot,
	AnimDocument,
	AnimFrame,
	AnimKeyframe,
	BindMode,
	ClipSource,
	FsBackend
} from './types.js';
export { BIND_MODES } from './types.js';

export {
	AnimParseError,
	assertClipMatchesDoc,
	parseAnimDocument,
	sameFsBackend,
	serializeAnimDocument
} from './document.js';

export { sampleClipFrame } from './sample.js';

export { createCompositionClock } from '@shared-packages/composition';
export type { ClockState, CompositionClock } from '@shared-packages/composition';
