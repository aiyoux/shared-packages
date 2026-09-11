import * as algorithm from '../detect/algorithm.js';

/**
 * Build the classic-worker source.
 *
 * OpenCV.js is a classic script, so it has to arrive through `importScripts`,
 * which rules out a module worker — the worker must be plain source text. The
 * detection algorithm still lives in real, type-checked, unit-tested modules
 * (`../detect/algorithm.ts`); it is stringified in here rather than written
 * twice.
 *
 * Why this survives minification: a bundler renames a function and every call
 * site to it together, and `Function.prototype.toString` returns the renamed
 * source, so the emitted bundle stays internally consistent. The message
 * handler below is a literal string and is *not* renamed, so it reaches the
 * algorithm through aliases built from the live `fn.name` instead of hard-coded
 * identifiers.
 */
export function buildWorkerSource(): string {
	const emitted: string[] = [];
	for (const value of Object.values(algorithm)) {
		if (typeof value === 'function') emitted.push(value.toString());
	}
	const alias = [
		`var __detectQuad = ${algorithm.detectQuad.name};`,
		`var __warpImage = ${algorithm.warpImage.name};`,
		`var __enhanceImage = ${algorithm.enhanceImage.name};`
	].join('\n');

	return `'use strict';

let cvRef = null;

${emitted.join('\n\n')}

${alias}

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
			var quad = __detectQuad(cvRef, msg.buffer, msg.width, msg.height, msg.opts);
			reply(id, { ok: true, quad: quad });
			return;
		}
		if (msg.type === 'warp') {
			var warped = __warpImage(cvRef, msg.buffer, msg.width, msg.height, msg.quad, msg.opts);
			reply(id, { ok: true, width: warped.width, height: warped.height, buffer: warped.buffer }, [warped.buffer]);
			return;
		}
		if (msg.type === 'enhance') {
			var out = __enhanceImage(cvRef, msg.buffer, msg.width, msg.height, msg.opts);
			reply(id, { ok: true, width: out.width, height: out.height, buffer: out.buffer }, [out.buffer]);
			return;
		}
		throw new Error('Unknown OpenCV worker message: ' + msg.type);
	} catch (err) {
		reply(id, { ok: false, error: err && err.message ? err.message : String(err) });
	}
};
`;
}
