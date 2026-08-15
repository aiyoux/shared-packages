import { orderCorners, outputSize } from '../geometry.js';
import type { CvMat, OpenCv } from '../cv-types.js';
import type { DetectOptions, EnhanceOptions, Quad, ScanEngine, WarpOptions } from '../types.js';

let resolvedCv: OpenCv | null = null;
let loadPromise: Promise<OpenCv> | null = null;

function loadScript(src: string): Promise<void> {
	return new Promise((resolve, reject) => {
		if (document.querySelector('script[data-sp-opencv="1"]')) {
			resolve();
			return;
		}
		const script = document.createElement('script');
		script.async = true;
		script.dataset.spOpencv = '1';
		script.src = src;
		const timer = setTimeout(() => reject(new Error('Timed out downloading OpenCV.js')), 90_000);
		script.onload = () => {
			clearTimeout(timer);
			resolve();
		};
		script.onerror = () => {
			clearTimeout(timer);
			reject(new Error(`Failed to load OpenCV.js from ${src}`));
		};
		document.head.appendChild(script);
	});
}

async function loadCv(): Promise<OpenCv> {
	if (resolvedCv) return resolvedCv;
	if (!loadPromise) {
		loadPromise = (async () => {
			const g = globalThis as unknown as {
				cv?: OpenCv & { onRuntimeInitialized?: () => void };
			};
			if (g.cv && typeof g.cv.Mat === 'function') return g.cv;

			const { getOpenCvUrl } = await import('../engines.js');
			const url = getOpenCvUrl();
			if (!url) {
				throw new Error(
					'OpenCV.js URL missing. Call loadScanEngine({ opencvUrl }) with a classic-script URL (Vite: import the file with ?url).'
				);
			}
			await loadScript(url);
			const started = Date.now();
			while (Date.now() - started < 60_000) {
				if (g.cv && typeof g.cv.Mat === 'function') return g.cv;
				await new Promise((r) => setTimeout(r, 50));
			}
			throw new Error('OpenCV.js loaded but did not initialize (no cv.Mat).');
		})().catch((err) => {
			loadPromise = null;
			throw err;
		});
	}
	resolvedCv = await loadPromise;
	return resolvedCv;
}

function mustCv(): OpenCv {
	if (!resolvedCv) throw new Error('OpenCV.js is not loaded. Call load() first.');
	return resolvedCv;
}

function matBytes(mat: CvMat): Uint8ClampedArray {
	const data = (mat as unknown as { data: Uint8Array }).data;
	const copy = new Uint8ClampedArray(data.length);
	copy.set(data);
	return copy;
}

function toImageData(bytes: Uint8ClampedArray, width: number, height: number): ImageData {
	return new ImageData(bytes as unknown as ImageDataArray, width, height);
}

function toRgbaImageData(cv: OpenCv, mat: CvMat): ImageData {
	const rgba = new cv.Mat();
	try {
		cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
		return toImageData(matBytes(rgba), rgba.cols, rgba.rows);
	} catch {
		return toImageData(matBytes(mat), mat.cols, mat.rows);
	} finally {
		try {
			rgba.delete();
		} catch {
			/* already deleted or unused */
		}
	}
}

function contourToQuad(cv: OpenCv, cnt: CvMat): Quad | null {
	const peri = cv.arcLength(cnt, true);
	const approx = new cv.Mat();
	try {
		cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
		if (approx.rows !== 4) return null;
		if (!cv.isContourConvex(approx)) return null;
		const pts = [];
		for (let i = 0; i < 4; i++) {
			pts.push({ x: approx.data32S[i * 2]!, y: approx.data32S[i * 2 + 1]! });
		}
		return orderCorners(pts);
	} finally {
		approx.delete();
	}
}

function detectFromEdges(cv: OpenCv, edges: CvMat, minArea: number): Quad | null {
	const contours = new cv.MatVector();
	const hierarchy = new cv.Mat();
	try {
		cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
		let best: { area: number; quad: Quad } | null = null;
		for (let i = 0; i < contours.size(); i++) {
			const cnt = contours.get(i);
			const area = cv.contourArea(cnt);
			if (area < minArea) continue;
			const quad = contourToQuad(cv, cnt);
			if (!quad) continue;
			if (!best || area > best.area) best = { area, quad };
		}
		return best?.quad ?? null;
	} finally {
		contours.delete();
		hierarchy.delete();
	}
}

export const opencvEngine: ScanEngine = {
	id: 'opencv',

	async load() {
		await loadCv();
	},

	detectQuad(image, opts: DetectOptions = {}) {
		const cv = mustCv();
		const minArea = (opts.minAreaRatio ?? 0.12) * image.width * image.height;
		const src = cv.matFromImageData(image);
		const gray = new cv.Mat();
		const blur = new cv.Mat();
		const edges = new cv.Mat();
		const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
		try {
			cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
			cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
			cv.Canny(blur, edges, 50, 150);
			cv.dilate(edges, edges, kernel);
			const fromCanny = detectFromEdges(cv, edges, minArea);
			if (fromCanny) return fromCanny;
			cv.adaptiveThreshold(gray, edges, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 15, 4);
			return detectFromEdges(cv, edges, minArea);
		} finally {
			src.delete();
			gray.delete();
			blur.delete();
			edges.delete();
			kernel.delete();
		}
	},

	warp(image, quad, opts: WarpOptions = {}) {
		const cv = mustCv();
		const { width, height } = outputSize(quad, opts.maxEdge ?? 1600);
		const src = cv.matFromImageData(image);
		const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
			quad[0].x,
			quad[0].y,
			quad[1].x,
			quad[1].y,
			quad[2].x,
			quad[2].y,
			quad[3].x,
			quad[3].y
		]);
		const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]);
		const dest = new cv.Mat();
		let M: CvMat | null = null;
		try {
			M = cv.getPerspectiveTransform(srcTri, dstTri);
			cv.warpPerspective(src, dest, M, new cv.Size(width, height));
			return toRgbaImageData(cv, dest);
		} finally {
			src.delete();
			srcTri.delete();
			dstTri.delete();
			dest.delete();
			M?.delete();
		}
	},

	enhance(image, opts: EnhanceOptions = {}) {
		const cv = mustCv();
		const src = cv.matFromImageData(image);
		const gray = new cv.Mat();
		const out = new cv.Mat();
		const block = nearestOdd(opts.blockSize ?? 15);
		try {
			cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
			cv.adaptiveThreshold(
				gray,
				out,
				255,
				cv.ADAPTIVE_THRESH_GAUSSIAN_C,
				cv.THRESH_BINARY,
				block,
				opts.C ?? 8
			);
			return toRgbaImageData(cv, out);
		} finally {
			src.delete();
			gray.delete();
			out.delete();
		}
	}
};

function nearestOdd(n: number): number {
	const v = Math.max(3, Math.round(n));
	return v % 2 === 0 ? v + 1 : v;
}
