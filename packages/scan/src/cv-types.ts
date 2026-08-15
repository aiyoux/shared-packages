/** Minimal OpenCV.js surface used by the scan engine. */
export type CvMat = {
	rows: number;
	cols: number;
	data32S: Int32Array;
	delete(): void;
};

export type CvMatVector = {
	size(): number;
	get(i: number): CvMat;
	delete(): void;
};

export type CvSize = { width: number; height: number };

export type OpenCv = {
	Mat: new () => CvMat;
	MatVector: new () => CvMatVector;
	Size: new (w: number, h: number) => CvSize;
	matFromImageData(data: ImageData): CvMat;
	matFromArray(rows: number, cols: number, type: number, array: number[]): CvMat;
	cvtColor(src: CvMat, dst: CvMat, code: number): void;
	GaussianBlur(src: CvMat, dst: CvMat, ksize: CvSize, sigmaX: number): void;
	Canny(src: CvMat, dst: CvMat, t1: number, t2: number): void;
	dilate(src: CvMat, dst: CvMat, kernel: CvMat): void;
	getStructuringElement(shape: number, ksize: CvSize): CvMat;
	findContours(src: CvMat, contours: CvMatVector, hierarchy: CvMat, mode: number, method: number): void;
	contourArea(cnt: CvMat): number;
	arcLength(cnt: CvMat, closed: boolean): number;
	approxPolyDP(cnt: CvMat, approx: CvMat, epsilon: number, closed: boolean): void;
	isContourConvex(cnt: CvMat): boolean;
	adaptiveThreshold(
		src: CvMat,
		dst: CvMat,
		maxValue: number,
		adaptiveMethod: number,
		thresholdType: number,
		blockSize: number,
		C: number
	): void;
	getPerspectiveTransform(src: CvMat, dst: CvMat): CvMat;
	warpPerspective(src: CvMat, dst: CvMat, m: CvMat, dsize: CvSize): void;
	COLOR_RGBA2GRAY: number;
	COLOR_GRAY2RGBA: number;
	RETR_LIST: number;
	CHAIN_APPROX_SIMPLE: number;
	MORPH_RECT: number;
	CV_32FC2: number;
	ADAPTIVE_THRESH_GAUSSIAN_C: number;
	THRESH_BINARY: number;
};
