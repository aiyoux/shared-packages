const fs = require('node:fs');
const path = require('node:path');
const { opencvPath } = require('./env.cjs');

/**
 * Load the app's opencv.js under Node.
 *
 * The file is a UMD bundle, but Node's ESM detection misreads it and refuses to
 * give it `require`, so it is evaluated in an explicit CommonJS frame instead.
 * OpenCV 5 resolves to a promise for the module.
 */
let cached = null;
function loadCv() {
	if (cached) return cached;
	const file = opencvPath();
	const src = fs.readFileSync(file, 'utf8');
	const mod = { exports: {} };
	const fn = new Function('module', 'exports', 'require', '__dirname', '__filename', 'globalThis', src);
	fn(mod, mod.exports, require, path.dirname(file), file, globalThis);
	cached = Promise.resolve(mod.exports);
	return cached;
}
module.exports = { loadCv };
