/**
 * The reference vocabulary lives in `@shared-packages/doc-refs`, which depends
 * on nothing. It was declared here, and that made a composition of audio
 * recordings — and the hub's reference pipeline, and a drawing tool — depend on
 * the animation package to say "this points at a VFS node". `compositionVfs.ts`
 * declined and re-declared the shape structurally, which is the drift a single
 * declaration exists to prevent.
 *
 * Re-exported rather than removed: other worktrees are mid-flight against this
 * path, and this package is consumed live. Every consumer that wanted *only*
 * the vocabulary now imports `@shared-packages/doc-refs` — the voice-rec
 * composition store, the hub's registry and map, `drawing-tools`, the
 * sketcher's scene types. What still takes them from here are animation's own
 * consumers, naming a `BindMode` beside a dozen anim types, which is not the
 * dependency this move was about.
 */
import type { BindMode, DocSource } from '@shared-packages/doc-refs';

export {
	BIND_MODES,
	type BindMode,
	type DocSource,
	type FsBackend,
	type MonitorDocSource,
	type VfsDocSource
} from '@shared-packages/doc-refs';

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

/** A `DocSource` that may also name part of a sketch. Anim clips only. */
export type ClipSource = DocSource & { fragment?: SketchFragment };

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
	/** User-given object name, local to this document. Renaming a clip here
	 *  never touches a linked source file — it only labels the clip in the
	 *  object tree and timeline. Omit / empty = fall back to a derived label. */
	name?: string;
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

/** Window descriptor in the stored view record. Roles are opaque strings:
 *  the animation package stays app-agnostic; the host validates role ids
 *  against its own window catalog on load. */
export type AnimWindowData = { role: string; clockId?: string };

/** One playhead ("clock") of the workspace — time is the only persisted part;
 *  a reloaded document always resumes paused. */
export type AnimPlayheadData = { timeMs: number };

/** Per-user workspace state for one animation: window layout (`layout` is a
 *  serialized pane-layout tree, validated by the host), per-clock playhead
 *  positions, and the auto-keyframe toggle (whether drags record keyframes) —
 *  per clock id, so one playhead can auto-key while another previews without
 *  recording. Absent for a given clock id defaults to on (host's `?? true`).
 *
 *  **Not part of the document. Never write it into the file.** It describes
 *  one person's machine, so a document carrying it cannot produce identical
 *  bytes on two devices — which is exactly what `offline-project-collab.md`
 *  §5.2 needs for a deterministic checkpoint — and it makes every room
 *  combine conflict on layout drift that has nothing to do with the
 *  animation. The host persists it per `(viewer, document id)`; see
 *  `docViewStore.ts`. `parseAnimView` validates a stored record: the shape
 *  belongs with the format even though the data does not. */
export type AnimDocView = {
	layout?: unknown;
	windows?: Record<string, AnimWindowData>;
	playheads?: Record<string, AnimPlayheadData>;
	autoKeyframeByClock?: Record<string, boolean>;
};

/** The document's virtual canvas: the abstract coordinate space clip frames
 *  and keyframes live in, and the aspect ratio of the rendered canvas. */
export type AnimCanvas = { w: number; h: number };

/** Default virtual canvas — 16:9. */
export const DEFAULT_ANIM_CANVAS: AnimCanvas = { w: 1920, h: 1080 };

export type AnimDocument = {
	schemaVersion: 1;
	/** Travelling document identity. Never a VFS node id. */
	id?: string;
	/** Epoch ms. Travels with `id`; never a VFS `createdAt`. */
	createdAt?: number;
	durationMs: number;
	clips: AnimClip[];
	canvas?: AnimCanvas;
};
