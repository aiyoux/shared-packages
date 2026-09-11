const { sharpPath } = require('./env.cjs');
const sharp = require(sharpPath());

async function loadRgba(file) {
	const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	return { buffer: new Uint8ClampedArray(data), width: info.width, height: info.height };
}
module.exports = { loadRgba, sharp };
