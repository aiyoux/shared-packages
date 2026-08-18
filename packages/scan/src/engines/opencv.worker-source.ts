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

function matByteLength(mat) {
	var rows = mat.rows || 0;
	var cols = mat.cols || 0;
	var elem = 1;
	try {
		if (typeof mat.elemSize === 'function') elem = mat.elemSize();
		else if (typeof mat.channels === 'function') elem = mat.channels();
	} catch (e) {
		elem = 4;
	}
	return rows * cols * elem;
}

function matBytes(mat) {
	var n = matByteLength(mat);
	var src = mat.data;
	var copy = new Uint8ClampedArray(n);
	if (src && src.length >= n) {
		if (src.subarray) copy.set(src.subarray(0, n));
		else copy.set(src);
	} else if (src) {
		copy.set(src);
	}
	return copy;
}

function toRgbaImageData(cv, mat) {
	var channels = 0;
	try {
		channels = typeof mat.channels === 'function' ? mat.channels() : 0;
	} catch (e) {
		channels = 0;
	}
	if (channels === 4) {
		return { buffer: matBytes(mat).buffer, width: mat.cols, height: mat.rows };
	}
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

function quadArea(pts) {
	var acc = 0;
	for (var i = 0; i < 4; i++) {
		var a = pts[i];
		var b = pts[(i + 1) % 4];
		acc += a.x * b.y - b.x * a.y;
	}
	return Math.abs(acc) / 2;
}

function usableQuad(pts, width, height, minArea) {
	if (!pts || pts.length !== 4) return false;
	if (quadArea(pts) < minArea) return false;
	var minSide = Math.min(width, height) * 0.06;
	for (var i = 0; i < 4; i++) {
		if (dist(pts[i], pts[(i + 1) % 4]) < minSide) return false;
	}
	var slack = Math.max(width, height) * 0.08;
	for (var j = 0; j < 4; j++) {
		if (pts[j].x < -slack || pts[j].y < -slack) return false;
		if (pts[j].x > width + slack || pts[j].y > height + slack) return false;
	}
	return true;
}

function pointsFromMat(cv, mat) {
	if (!mat) return null;
	var data = null;
	try {
		if (typeof mat.depth === 'function' && typeof cv.CV_32F === 'number' && mat.depth() === cv.CV_32F) {
			data = mat.data32F;
		} else {
			data = mat.data32S || mat.data32F;
		}
	} catch (e) {
		data = mat.data32S || mat.data32F;
	}
	if (!data || data.length < 8) return null;
	var pts = [];
	for (var i = 0; i < 4; i++) {
		pts.push({ x: data[i * 2], y: data[i * 2 + 1] });
	}
	return pts;
}

function pointsFromBox(cv, rect) {
	try {
		if (cv.RotatedRect && typeof cv.RotatedRect.points === 'function') {
			var raw = cv.RotatedRect.points(rect);
			if (raw && raw.length === 4) {
				return [
					{ x: raw[0].x, y: raw[0].y },
					{ x: raw[1].x, y: raw[1].y },
					{ x: raw[2].x, y: raw[2].y },
					{ x: raw[3].x, y: raw[3].y }
				];
			}
		}
	} catch (e) {
		/* try boxPoints */
	}
	if (typeof cv.boxPoints === 'function') {
		var box = new cv.Mat();
		try {
			cv.boxPoints(rect, box);
			return pointsFromMat(cv, box);
		} finally {
			box.delete();
		}
	}
	return null;
}

function isConvex(cv, approx) {
	try {
		if (typeof cv.isContourConvex !== 'function') return true;
		return cv.isContourConvex(approx);
	} catch (e) {
		return true;
	}
}

function contourToQuad(cv, cnt) {
	var peri = cv.arcLength(cnt, true);
	var approx = new cv.Mat();
	var hull = new cv.Mat();
	try {
		var epsilons = [0.015, 0.02, 0.03, 0.045, 0.06, 0.08];
		var sources = [cnt];
		try {
			cv.convexHull(cnt, hull, false, true);
			if (hull.rows >= 4) sources.push(hull);
		} catch (e) {
			/* hull optional */
		}
		for (var s = 0; s < sources.length; s++) {
			for (var e = 0; e < epsilons.length; e++) {
				cv.approxPolyDP(sources[s], approx, epsilons[e] * peri, true);
				if (approx.rows !== 4) continue;
				if (!isConvex(cv, approx)) continue;
				var pts = pointsFromMat(cv, approx);
				if (pts) return orderCorners(pts);
			}
		}
		// Rounded / noisy pages often fail 4-point approx; min-area rect is close enough.
		try {
			var rect = cv.minAreaRect(cnt);
			var boxPts = pointsFromBox(cv, rect);
			if (boxPts && boxPts.length === 4) return orderCorners(boxPts);
		} catch (err) {
			/* minAreaRect optional */
		}
		return null;
	} finally {
		approx.delete();
		hull.delete();
	}
}

function scoreQuad(pts, width, height) {
	var area = quadArea(pts);
	var fill = area / (width * height || 1);
	// Prefer a page that fills a useful chunk of the frame, not a tiny card
	// or the entire sensor.
	var fillScore = 1;
	if (fill < 0.12) fillScore = fill / 0.12;
	else if (fill > 0.94) fillScore = Math.max(0.2, (1 - fill) / 0.06);
	var w = Math.max(dist(pts[0], pts[1]), dist(pts[3], pts[2]));
	var h = Math.max(dist(pts[0], pts[3]), dist(pts[1], pts[2]));
	var ar = w / (h || 1);
	var arScore = ar > 0.32 && ar < 3.2 ? 1 : 0.35;
	return area * fillScore * arScore;
}

function detectFromEdges(cv, edges, minArea, width, height) {
	var modes = [cv.RETR_EXTERNAL, cv.RETR_LIST];
	var best = null;
	var maxContours = 80;
	for (var m = 0; m < modes.length; m++) {
		var src = edges.clone();
		var contours = new cv.MatVector();
		var hierarchy = new cv.Mat();
		try {
			cv.findContours(src, contours, hierarchy, modes[m], cv.CHAIN_APPROX_SIMPLE);
			var n = Math.min(contours.size(), maxContours);
			for (var i = 0; i < n; i++) {
				var cnt = contours.get(i);
				var area = cv.contourArea(cnt);
				if (area < minArea) continue;
				var quad = contourToQuad(cv, cnt);
				if (!quad || !usableQuad(quad, width, height, minArea)) continue;
				var score = scoreQuad(quad, width, height);
				if (!best || score > best.score) best = { score: score, quad: quad };
			}
		} finally {
			src.delete();
			contours.delete();
			hierarchy.delete();
		}
		if (best) return best.quad;
	}
	return best ? best.quad : null;
}

function matFromRgba(cv, buffer, width, height) {
	var bytes = buffer instanceof Uint8Array ? buffer : new Uint8ClampedArray(buffer);
	if (typeof cv.CV_8UC4 !== 'number') {
		throw new Error('OpenCV CV_8UC4 missing');
	}
	var expected = width * height * 4;
	if (bytes.length < expected) {
		throw new Error('Image buffer is shorter than width*height*4');
	}
	var src = new cv.Mat(height, width, cv.CV_8UC4);
	src.data.set(bytes.subarray ? bytes.subarray(0, expected) : bytes);
	return src;
}

function scaleFoundQuad(quad, scale) {
	if (!quad || scale === 1) return quad;
	var inv = 1 / scale;
	return [
		{ x: quad[0].x * inv, y: quad[0].y * inv },
		{ x: quad[1].x * inv, y: quad[1].y * inv },
		{ x: quad[2].x * inv, y: quad[2].y * inv },
		{ x: quad[3].x * inv, y: quad[3].y * inv }
	];
}

function detectOnGray(cv, gray, minArea, width, height) {
	var work = new cv.Mat();
	var edges = new cv.Mat();
	var closeK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
	var dilateK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
	try {
		function fromBinary() {
			return detectFromEdges(cv, edges, minArea, width, height);
		}
		// Text at native resolution drowns the page outline. Blur first so
		// Canny sees the sheet, then dilate/close so the border reconnects.
		cv.GaussianBlur(gray, work, new cv.Size(5, 5), 0);
		var cannyPairs = [[20, 70], [40, 120], [75, 200]];
		for (var c = 0; c < cannyPairs.length; c++) {
			try {
				cv.Canny(work, edges, cannyPairs[c][0], cannyPairs[c][1]);
				cv.dilate(edges, edges, dilateK);
				cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, closeK);
				var fromCanny = fromBinary();
				if (fromCanny) return fromCanny;
			} catch (e) {
				/* next Canny pair */
			}
		}
		var threshModes = [
			[cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 21, 5],
			[cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 5],
			[cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, 15, 4]
		];
		for (var t = 0; t < threshModes.length; t++) {
			try {
				cv.adaptiveThreshold(
					gray,
					edges,
					255,
					threshModes[t][0],
					threshModes[t][1],
					threshModes[t][2],
					threshModes[t][3]
				);
				cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, closeK);
				var fromBin = fromBinary();
				if (fromBin) return fromBin;
			} catch (e) {
				/* next threshold */
			}
		}
		try {
			cv.GaussianBlur(gray, work, new cv.Size(11, 11), 0);
			cv.threshold(work, edges, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
			cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, closeK);
			var fromOtsu = fromBinary();
			if (fromOtsu) return fromOtsu;
			cv.threshold(work, edges, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
			cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, closeK);
			return fromBinary();
		} catch (e) {
			return null;
		}
	} finally {
		work.delete();
		edges.delete();
		closeK.delete();
		dilateK.delete();
	}
}

function detectQuad(cv, buffer, width, height, opts) {
	opts = opts || {};
	var maxEdge = opts.maxDetectEdge != null ? opts.maxDetectEdge : 480;
	var src = matFromRgba(cv, buffer, width, height);
	var resized = null;
	var scale = 1;
	try {
		var longest = Math.max(width, height);
		var work = src;
		var dw = width;
		var dh = height;
		// Tiny frames hit pathological OpenCV.js paths (detect never returns).
		// Always run around 360–480px on the long edge.
		var minEdge = 360;
		if (longest > maxEdge || longest < minEdge) {
			scale = (longest > maxEdge ? maxEdge : minEdge) / longest;
			dw = Math.max(2, Math.round(width * scale));
			dh = Math.max(2, Math.round(height * scale));
			resized = new cv.Mat();
			cv.resize(src, resized, new cv.Size(dw, dh), 0, 0, cv.INTER_AREA);
			work = resized;
		}
		var minArea = (opts.minAreaRatio != null ? opts.minAreaRatio : 0.04) * dw * dh;
		var gray = new cv.Mat();
		var boosted = new cv.Mat();
		try {
			cv.cvtColor(work, gray, cv.COLOR_RGBA2GRAY);
			var found = detectOnGray(cv, gray, minArea, dw, dh);
			if (found) return scaleFoundQuad(found, scale);
			try {
				if (typeof cv.CLAHE === 'function') {
					var clahe = new cv.CLAHE(2, new cv.Size(8, 8));
					clahe.apply(gray, boosted);
					clahe.delete();
					found = detectOnGray(cv, boosted, minArea, dw, dh);
					if (found) return scaleFoundQuad(found, scale);
				}
			} catch (e) {
				/* CLAHE optional */
			}
			return null;
		} finally {
			gray.delete();
			boosted.delete();
		}
	} finally {
		src.delete();
		if (resized) resized.delete();
	}
}

function warp(cv, buffer, width, height, quad, opts) {
	opts = opts || {};
	var size = outputSize(quad, opts.maxEdge || 1600);
	var src = matFromRgba(cv, buffer, width, height);
	var pts = [
		+quad[0].x, +quad[0].y, +quad[1].x, +quad[1].y, +quad[2].x, +quad[2].y, +quad[3].x, +quad[3].y
	];
	var srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, pts);
	var dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, size.width, 0, size.width, size.height, 0, size.height]);
	var dest = new cv.Mat(size.height, size.width, src.type ? src.type() : cv.CV_8UC4);
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

function enhance(cv, buffer, width, height, opts) {
	opts = opts || {};
	var src = matFromRgba(cv, buffer, width, height);
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
			var quad = detectQuad(cvRef, msg.buffer, msg.width, msg.height, msg.opts);
			reply(id, { ok: true, quad: quad });
			return;
		}
		if (msg.type === 'warp') {
			var warped = warp(cvRef, msg.buffer, msg.width, msg.height, msg.quad, msg.opts);
			reply(id, { ok: true, width: warped.width, height: warped.height, buffer: warped.buffer }, [warped.buffer]);
			return;
		}
		if (msg.type === 'enhance') {
			var out = enhance(cvRef, msg.buffer, msg.width, msg.height, msg.opts);
			reply(id, { ok: true, width: out.width, height: out.height, buffer: out.buffer }, [out.buffer]);
			return;
		}
		throw new Error('Unknown OpenCV worker message: ' + msg.type);
	} catch (err) {
		reply(id, { ok: false, error: err && err.message ? err.message : String(err) });
	}
};
`;
