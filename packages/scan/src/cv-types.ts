/**
 * The OpenCV.js surface the scan engine uses.
 *
 * Hand-written rather than pulled from `@techstark/opencv-js` because the
 * engine runs against whatever `opencv.js` the host app serves, and this
 * records exactly which calls that build has to provide.
 */
export type CvMat = {
	rows: number;
	cols: number;
	data: Uint8Array;
	data32S: Int32Array;
	data32F: Float32Array;
	clone(): CvMat;
	type(): number;
	depth(): number;
	channels(): number;
	elemSize(): number;
	delete(): void;
};

export type CvMatVector = {
	size(): number;
	get(i: number): CvMat;
	delete(): void;
};

export type CvSize = { width: number; height: number };

export type CvRotatedRect = {
	center: { x: number; y: number };
	size: CvSize;
	angle: number;
};

export type CvClahe = {
	apply(src: CvMat, dst: CvMat): void;
	delete(): void;
};

export type OpenCv = {
	Mat: {
		new (): CvMat;
		new (rows: number, cols: number, type: number): CvMat;
	};
	MatVector: new () => CvMatVector;
	Size: new (w: number, h: number) => CvSize;
	CLAHE: new (clipLimit: number, tileGridSize: CvSize) => CvClahe;
	RotatedRect?: { points(rect: CvRotatedRect): { x: number; y: number }[] };

	matFromImageData(data: ImageData): CvMat;
	matFromArray(rows: number, cols: number, type: number, array: number[]): CvMat;
	cvtColor(src: CvMat, dst: CvMat, code: number): void;
	resize(src: CvMat, dst: CvMat, dsize: CvSize, fx: number, fy: number, interpolation: number): void;
	GaussianBlur(src: CvMat, dst: CvMat, ksize: CvSize, sigmaX: number): void;
	Canny(src: CvMat, dst: CvMat, t1: number, t2: number): void;
	threshold(src: CvMat, dst: CvMat, thresh: number, maxval: number, type: number): number;
	adaptiveThreshold(
		src: CvMat,
		dst: CvMat,
		maxValue: number,
		adaptiveMethod: number,
		thresholdType: number,
		blockSize: number,
		C: number
	): void;
	dilate(src: CvMat, dst: CvMat, kernel: CvMat): void;
	morphologyEx(src: CvMat, dst: CvMat, op: number, kernel: CvMat): void;
	getStructuringElement(shape: number, ksize: CvSize): CvMat;

	findContours(src: CvMat, contours: CvMatVector, hierarchy: CvMat, mode: number, method: number): void;
	contourArea(cnt: CvMat): number;
	arcLength(cnt: CvMat, closed: boolean): number;
	approxPolyDP(cnt: CvMat, approx: CvMat, epsilon: number, closed: boolean): void;
	convexHull(cnt: CvMat, hull: CvMat, clockwise: boolean, returnPoints: boolean): void;
	isContourConvex(cnt: CvMat): boolean;
	minAreaRect(cnt: CvMat): CvRotatedRect;
	boxPoints(rect: CvRotatedRect, box: CvMat): void;

	getPerspectiveTransform(src: CvMat, dst: CvMat): CvMat;
	warpPerspective(src: CvMat, dst: CvMat, m: CvMat, dsize: CvSize): void;

	COLOR_RGBA2GRAY: number;
	COLOR_GRAY2RGBA: number;
	RETR_LIST: number;
	RETR_EXTERNAL: number;
	CHAIN_APPROX_SIMPLE: number;
	MORPH_RECT: number;
	MORPH_OPEN: number;
	MORPH_CLOSE: number;
	INTER_AREA: number;
	CV_32F: number;
	CV_32FC2: number;
	CV_8UC4: number;
	ADAPTIVE_THRESH_GAUSSIAN_C: number;
	ADAPTIVE_THRESH_MEAN_C: number;
	THRESH_BINARY: number;
	THRESH_BINARY_INV: number;
	THRESH_OTSU: number;
};
