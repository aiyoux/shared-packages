export const BIND_MODES = ['clone', 'live', 'snapshot', 'gitPin'] as const;

export type BindMode = (typeof BIND_MODES)[number];

export type ClipSource =
	| { backend: 'shared-vfs'; nodeId: string; generation?: number; blobId?: string }
	| { backend: 'monitor'; profileId: string; ino?: string; dev?: string; relPath: string };

export type FsBackend = ClipSource['backend'];

/** Axis-aligned box. Rotation is not part of v1. */
export type AnimFrame = { x: number; y: number; w: number; h: number };

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
	snapshot?: AnimClipSnapshot;
};

export type AnimClip =
	| (AnimClipBase & { bind: 'clone' })
	| (AnimClipBase & { bind: Exclude<BindMode, 'clone'>; source: ClipSource });

export type AnimDocument = {
	schemaVersion: 1;
	durationMs: number;
	clips: AnimClip[];
};
