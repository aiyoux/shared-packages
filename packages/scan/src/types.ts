export type Point = { x: number; y: number };

/** Corners in image space, clockwise from top-left: TL, TR, BR, BL. */
export type Quad = [Point, Point, Point, Point];

export type ScanPage = {
	id: string;
	blob: Blob;
	width: number;
	height: number;
	text?: string;
};

export type DetectOptions = {
	/**
	 * Reject quads smaller than this fraction of the frame. Default 0.02.
	 * Kept low on purpose: size is no longer what separates a document from the
	 * surface under it, so this only discards specks.
	 */
	minAreaRatio?: number;
	/** Longest edge (px) to run detection at. Larger frames are downscaled first. Default 480. */
	maxDetectEdge?: number;
};

export type WarpOptions = {
	maxEdge?: number;
};

export type EnhanceOptions = {
	blockSize?: number;
	C?: number;
};

export type ScanLoadProgress = {
	phase: 'download' | 'init';
	loaded?: number;
	total?: number;
};

/**
 * Document-corner detector backends. `opencv` is the bundled classical
 * pipeline; the rest are learned models that download weights on first use
 * (browser cache) and never silently substitute for each other.
 */
export type ScanDetectorId = 'opencv' | 'scanic' | 'docquad' | 'docaligner' | 'yolo-pose';

export type ScanEngine = {
	readonly id: ScanDetectorId;
	load(): Promise<void>;
	detectQuad(image: ImageData, opts?: DetectOptions): Promise<Quad | null>;
	warp(image: ImageData, quad: Quad, opts?: WarpOptions): Promise<ImageData>;
	enhance(image: ImageData, opts?: EnhanceOptions): Promise<ImageData>;
};

export type QuadLockStatus = {
	locked: boolean;
	progress: number;
	quad: Quad | null;
};

export type ContainRect = {
	x: number;
	y: number;
	width: number;
	height: number;
	scale: number;
};
