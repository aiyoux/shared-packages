export const BIND_MODES = ['clone', 'live', 'snapshot', 'gitPin'] as const;

export type BindMode = (typeof BIND_MODES)[number];

export const SKETCH_OBJECT_KINDS = ['image', 'bake', 'sticker', 'text', 'path'] as const;
export type SketchObjectKind = (typeof SKETCH_OBJECT_KINDS)[number];

export const SKETCH_FRAGMENT_KINDS = ['file', 'page', 'layer', 'object'] as const;
export type SketchFragmentKind = (typeof SKETCH_FRAGMENT_KINDS)[number];

/** Omit / `{ kind: 'file' }` = whole VFS/monitor file (image clips). */
export type SketchFragment =
	| { kind: 'file' }
	| { kind: 'page'; pageId: string }
	| { kind: 'layer'; pageId: string; layerId: string }
	| {
			kind: 'object';
			pageId: string;
			layerId: string;
			objectKind: SketchObjectKind;
			objectId: string;
	  };

export type ClipSource =
	| {
			backend: 'shared-vfs';
			nodeId: string;
			generation?: number;
			blobId?: string;
			fragment?: SketchFragment;
	  }
	| {
			backend: 'monitor';
			profileId: string;
			ino?: string;
			dev?: string;
			relPath: string;
			fragment?: SketchFragment;
	  };

export type FsBackend = ClipSource['backend'];

export const CLIP_MEDIA_KINDS = ['image', 'sketch-fragment', 'video', 'audio'] as const;
export type ClipMediaKind = (typeof CLIP_MEDIA_KINDS)[number];

/** Canvas box. `rotation` is radians, clockwise, default 0. */
export type AnimFrame = { x: number; y: number; w: number; h: number; rotation?: number };

/** Pose at `tMs` relative to the clip start. Omitted channels hold the previous pose. */
export type AnimKeyframe = {
	tMs: number;
	x?: number;
	y?: number;
	w?: number;
	h?: number;
	rotation?: number;
};

export type AnimClipSnapshot = {
	bytesRef: string;
	atGeneration?: number;
	atCommit?: string;
};

type AnimClipBase = {
	id: string;
	startMs: number;
	durationMs: number;
	frame: AnimFrame;
	keyframes?: AnimKeyframe[];
	snapshot?: AnimClipSnapshot;
	/** Omit = `'image'`. Required `'sketch-fragment'` on fragment clips. */
	mediaKind?: ClipMediaKind;
	/** Links a video clip to the audio clip created from the same file. */
	pairId?: string;
};

export type AnimClip =
	| (AnimClipBase & { bind: 'clone' })
	| (AnimClipBase & { bind: Exclude<BindMode, 'clone'>; source: ClipSource });

/**
 * A clip that carries a `source` — i.e. every bind mode except `clone`.
 *
 * `AnimClip` is discriminated on `bind`, so a plain
 * `.filter((c) => c.source.backend === 'monitor')` narrows nothing: the
 * predicate returns `boolean`, and the following `.map` still sees the whole
 * `ClipSource` union. The guards below narrow both halves at once.
 */
export type BoundClip = Extract<AnimClip, { source: ClipSource }>;

/** A bound clip whose source is on a specific backend. */
export type ClipOnBackend<B extends ClipSource['backend']> = BoundClip & {
	source: Extract<ClipSource, { backend: B }>;
};

/** Narrows away `clone` clips, which have no `source`. */
export function isBoundClip(clip: AnimClip): clip is BoundClip {
	return clip.bind !== 'clone';
}

/** Narrows to bound clips sourced from `backend`. */
export function clipOnBackend<B extends ClipSource['backend']>(
	clip: AnimClip,
	backend: B
): clip is ClipOnBackend<B> {
	return clip.bind !== 'clone' && clip.source.backend === backend;
}

/** Window descriptor in the persisted `view` block. Roles are opaque strings:
 *  the animation package stays app-agnostic; the host validates role ids
 *  against its own window catalog on load. */
export type AnimWindowData = { role: string; clockId?: string };

/** One playhead ("clock") of the workspace — time is the only persisted part;
 *  a reloaded document always resumes paused. */
export type AnimPlayheadData = { timeMs: number };

/** App/workspace state that travels with the document but is never
 *  authoring data: window layout (`layout` is a serialized pane-layout tree,
 *  validated by the host), per-clock playhead positions, and the
 *  auto-keyframe toggle (whether drags record keyframes). */
export type AnimDocView = {
	layout?: unknown;
	windows?: Record<string, AnimWindowData>;
	playheads?: Record<string, AnimPlayheadData>;
	autoKeyframe?: boolean;
};

/** The document's virtual canvas: the abstract coordinate space clip frames
 *  and keyframes live in, and the aspect ratio of the rendered canvas. */
export type AnimCanvas = { w: number; h: number };

/** Default virtual canvas — 16:9. */
export const DEFAULT_ANIM_CANVAS: AnimCanvas = { w: 1920, h: 1080 };

export type AnimDocument = {
	schemaVersion: 1;
	durationMs: number;
	clips: AnimClip[];
	canvas?: AnimCanvas;
	view?: AnimDocView;
};
