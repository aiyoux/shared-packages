// The bench borrows two things from a host app rather than adding dependencies
// to the package: the opencv.js build the app actually serves, and sharp for
// decoding images. Point these at your checkout if the defaults are wrong.
const path = require('node:path');
const fs = require('node:fs');

const HOST = process.env.SCAN_BENCH_HOST || path.resolve(__dirname, '../../../../../../scratch-pad/terminal');

function need(p, what) {
	if (!fs.existsSync(p)) {
		throw new Error(
			`detect-bench: ${what} not found at ${p}.\n` +
				'Set SCAN_BENCH_HOST to an app that has static/vendor/opencv.js and sharp installed, ' +
				'or SCAN_BENCH_OPENCV / SCAN_BENCH_SHARP to override individually.'
		);
	}
	return p;
}

const opencvPath = () =>
	need(process.env.SCAN_BENCH_OPENCV || path.join(HOST, 'static/vendor/opencv.js'), 'opencv.js');
const sharpPath = () =>
	need(process.env.SCAN_BENCH_SHARP || path.join(HOST, 'node_modules/sharp'), 'sharp');

module.exports = { opencvPath, sharpPath };
