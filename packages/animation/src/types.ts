export const BIND_MODES = ['clone', 'live', 'snapshot', 'gitPin'] as const;

export type BindMode = (typeof BIND_MODES)[number];

export const SKETCH_OBJECT_KINDS = ['image', 'bake', 'sticker', 'text', 'path'] as const;
export type SketchObjectKind = (typeof SKETCH_OBJECT_KINDS)[number];

export const SKETCH_FRAGMENT_KINDS = ['file', 'page', 'layer', 'object'] as const;
export type SketchFragmentKind = (typeof SKETCH_FRAGMENT_KINDS)[number];

/** Omit / `{ kind: 'file' }` = whole VFS/monitor file (v1 image clips). */
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

export const CLIP_MEDIA_KINDS = ['image', 'sketch-fragment'] as const;
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
	/** Omit = `'image'`. Required `'sketch-fragment'` on v2 fragment clips. */
	mediaKind?: ClipMediaKind;
};

export type AnimClip =
	| (AnimClipBase & { bind: 'clone' })
	| (AnimClipBase & { bind: Exclude<BindMode, 'clone'>; source: ClipSource });

export type AnimDocument = {
	schemaVersion: 1 | 2;
	durationMs: number;
	clips: AnimClip[];
};
