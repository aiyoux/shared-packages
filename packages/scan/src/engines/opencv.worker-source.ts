/** Classic-worker source. Loaded via Blob so Vite/yalc never parse opencv.js. */
export const OPENCV_WORKER_SOURCE = `
'use strict';

let cvRef = null;

function dist(a, b) {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function orderCorners(pts) {
	const bySum = pts.slice().sort(function (a, b) { return a.x + a.y - (b.x + b.y); });
	const tl = bySum[0];
	const br = bySum[3];
	const rest = [bySum[1], bySum[2]];
	const tr = rest[0].x >= rest[1].x ? rest[0] : rest[1];
	const bl = rest[0].x >= rest[1].x ? rest[1] : rest[0];
	return [tl, tr, br, bl];
}

function outputSize(quad, maxEdge) {
	maxEdge = maxEdge || 1600;
	var tl = quad[0], tr = quad[1], br = quad[2], bl = quad[3];
	var w = Math.max(dist(tl, tr), dist(bl, br));
	var h = Math.max(dist(tl, bl), dist(tr, br));
	if (!(w > 1) || !(h > 1)) return { width: 800, height: 1100 };
	var scale = Math.min(1, maxEdge / Math.max(w, h));
	return {
		width: Math.max(2, Math.round(w * scale / 2) * 2),
		height: Math.max(2, Math.round(h * scale / 2) * 2)
	};
}

function nearestOdd(n) {
	var v = Math.max(3, Math.round(n));
	return v % 2 === 0 ? v + 1 : v;
}

function matBytes(mat) {
	var copy = new Uint8ClampedArray(mat.data.length);
	copy.set(mat.data);
	return copy;
}

function toRgbaImageData(cv, mat) {
	var rgba = new cv.Mat();
	try {
		cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
		return { buffer: matBytes(rgba).buffer, width: rgba.cols, height: rgba.rows };
	} catch (err) {
		return { buffer: matBytes(mat).buffer, width: mat.cols, height: mat.rows };
	} finally {
		try { rgba.delete(); } catch (e) { /* unused */ }
	}
}

function contourToQuad(cv, cnt) {
	var peri = cv.arcLength(cnt, true);
	var approx = new cv.Mat();
	try {
		cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
		if (approx.rows !== 4) return null;
		if (!cv.isContourConvex(approx)) return null;
		var pts = [];
		for (var i = 0; i < 4; i++) {
			pts.push({ x: approx.data32S[i * 2], y: approx.data32S[i * 2 + 1] });
		}
		return orderCorners(pts);
	} finally {
		approx.delete();
	}
}

function detectFromEdges(cv, edges, minArea) {
	var contours = new cv.MatVector();
	var hierarchy = new cv.Mat();
	try {
		cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
		var best = null;
		for (var i = 0; i < contours.size(); i++) {
			var cnt = contours.get(i);
			var area = cv.contourArea(cnt);
			if (area < minArea) continue;
			var quad = contourToQuad(cv, cnt);
			if (!quad) continue;
			if (!best || area > best.area) best = { area: area, quad: quad };
		}
		return best ? best.quad : null;
	} finally {
		contours.delete();
		hierarchy.delete();
	}
}

function toImage(buffer, width, height) {
	return new ImageData(new Uint8ClampedArray(buffer), width, height);
}

function detectQuad(cv, image, opts) {
	opts = opts || {};
	var minArea = (opts.minAreaRatio != null ? opts.minAreaRatio : 0.12) * image.width * image.height;
	var src = cv.matFromImageData(image);
	var gray = new cv.Mat();
	var blur = new cv.Mat();
	var edges = new cv.Mat();
	var kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
	try {
		cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
		cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
		cv.Canny(blur, edges, 50, 150);
		cv.dilate(edges, edges, kernel);
		var fromCanny = detectFromEdges(cv, edges, minArea);
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
}

function warp(cv, image, quad, opts) {
	opts = opts || {};
	var size = outputSize(quad, opts.maxEdge || 1600);
	var src = cv.matFromImageData(image);
	var srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
		quad[0].x, quad[0].y, quad[1].x, quad[1].y, quad[2].x, quad[2].y, quad[3].x, quad[3].y
	]);
	var dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, size.width, 0, size.width, size.height, 0, size.height]);
	var dest = new cv.Mat();
	var M = null;
	try {
		M = cv.getPerspectiveTransform(srcTri, dstTri);
		cv.warpPerspective(src, dest, M, new cv.Size(size.width, size.height));
		return toRgbaImageData(cv, dest);
	} finally {
		src.delete();
		srcTri.delete();
		dstTri.delete();
		dest.delete();
		if (M) M.delete();
	}
}

function enhance(cv, image, opts) {
	opts = opts || {};
	var src = cv.matFromImageData(image);
	var gray = new cv.Mat();
	var out = new cv.Mat();
	var block = nearestOdd(opts.blockSize || 15);
	try {
		cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
		cv.adaptiveThreshold(gray, out, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, opts.C != null ? opts.C : 8);
		return toRgbaImageData(cv, out);
	} finally {
		src.delete();
		gray.delete();
		out.delete();
	}
}

function waitForCv(timeoutMs) {
	return new Promise(function (resolve, reject) {
		var deadline = Date.now() + timeoutMs;
		var finished = false;
		function done() {
			return self.cv && typeof self.cv.Mat === 'function';
		}
		function finishOk() {
			if (finished) return;
			finished = true;
			resolve(self.cv);
		}
		function finishErr(err) {
			if (finished) return;
			finished = true;
			reject(err);
		}
		if (done()) {
			finishOk();
			return;
		}
		if (self.cv) {
			var prev = self.cv.onRuntimeInitialized;
			self.cv.onRuntimeInitialized = function () {
				if (typeof prev === 'function') prev();
				if (done()) finishOk();
			};
		}
		var timer = setInterval(function () {
			if (done()) {
				clearInterval(timer);
				finishOk();
			} else if (Date.now() > deadline) {
				clearInterval(timer);
				finishErr(new Error('OpenCV.js loaded but did not initialize (no cv.Mat).'));
			}
		}, 25);
	});
}

function reply(id, payload, transfer) {
	var msg = Object.assign({ id: id }, payload);
	if (transfer && transfer.length) self.postMessage(msg, transfer);
	else self.postMessage(msg);
}

self.onmessage = function (event) {
	var msg = event.data || {};
	var id = msg.id;
	try {
		if (msg.type === 'init') {
			if (!msg.url) throw new Error('OpenCV.js worker URL missing.');
			// opencv.js getBinaryPromise() fetch()es the embedded data: WASM URI.
			// Chromium workers hang on that fetch, so force the sync data-URI decoder.
			var nativeFetch = self.fetch;
			self.fetch = function (input, init) {
				var href = typeof input === 'string' ? input : input && input.url;
				if (typeof href === 'string' && href.indexOf('data:') === 0) {
					return Promise.reject(new Error('skip-data-uri-fetch'));
				}
				return nativeFetch.apply(self, arguments);
			};
			var settled = false;
			function succeed(cv) {
				if (settled) return;
				if (!cv || typeof cv.Mat !== 'function') return;
				settled = true;
				cvRef = cv;
				reply(id, { ok: true });
			}
			function fail(err) {
				if (settled) return;
				settled = true;
				reply(id, { ok: false, error: err && err.message ? err.message : String(err) });
			}
			self.Module = {
				onRuntimeInitialized: function () {
					succeed(self.cv);
				}
			};
			try {
				importScripts(msg.url);
			} catch (err) {
				fail(err);
				return;
			}
			if (self.cv && typeof self.cv.then === 'function') {
				try {
					self.cv.then(function (mod) { succeed(mod || self.cv); });
				} catch (err) {
					/* Module.then is not a real Promise */
				}
			}
			waitForCv(120000).then(succeed).catch(fail);
			return;
		}
		if (!cvRef) throw new Error('OpenCV.js is not loaded.');
		if (msg.type === 'detect') {
			var quad = detectQuad(cvRef, toImage(msg.buffer, msg.width, msg.height), msg.opts);
			reply(id, { ok: true, quad: quad });
			return;
		}
		if (msg.type === 'warp') {
			var warped = warp(cvRef, toImage(msg.buffer, msg.width, msg.height), msg.quad, msg.opts);
			reply(id, { ok: true, width: warped.width, height: warped.height, buffer: warped.buffer }, [warped.buffer]);
			return;
		}
		if (msg.type === 'enhance') {
			var out = enhance(cvRef, toImage(msg.buffer, msg.width, msg.height), msg.opts);
			reply(id, { ok: true, width: out.width, height: out.height, buffer: out.buffer }, [out.buffer]);
			return;
		}
		throw new Error('Unknown OpenCV worker message: ' + msg.type);
	} catch (err) {
		reply(id, { ok: false, error: err && err.message ? err.message : String(err) });
	}
};
`;
