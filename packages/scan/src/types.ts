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
	/** Reject quads smaller than this fraction of the frame. */
	minAreaRatio?: number;
};

export type WarpOptions = {
	maxEdge?: number;
};

export type EnhanceOptions = {
	blockSize?: number;
	C?: number;
};

export type ScanEngine = {
	readonly id: 'opencv';
	load(): Promise<void>;
	detectQuad(image: ImageData, opts?: DetectOptions): Quad | null;
	warp(image: ImageData, quad: Quad, opts?: WarpOptions): ImageData;
	enhance(image: ImageData, opts?: EnhanceOptions): ImageData;
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
