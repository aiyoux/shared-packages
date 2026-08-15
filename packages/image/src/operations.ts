import { loadEngine } from './engines.js';
import { detectFormat, suggestOutputName } from './detect.js';
import {
	clampQuality,
	type EngineId,
	type ImageFormat,
	type RasterImage
} from './types.js';

export type ConvertOptions = {
	format: ImageFormat;
	quality?: number;
	width?: number;
	height?: number;
	name?: string;
};

export type ConvertedImage = {
	name: string;
	data: Uint8Array;
	format: ImageFormat;
	width: number;
	height: number;
	sourceBytes: number;
	sourceWidth: number;
	sourceHeight: number;
};

export async function decodeImage(
	engineId: EngineId,
	bytes: Uint8Array,
	name?: string
): Promise<RasterImage> {
	const engine = await loadEngine(engineId);
	const hint = detectFormat(bytes, name)?.format;
	return engine.decode(bytes, hint);
}

export async function convertImage(
	engineId: EngineId,
	bytes: Uint8Array,
	options: ConvertOptions
): Promise<ConvertedImage> {
	const engine = await loadEngine(engineId);
	const hint = detectFormat(bytes, options.name)?.format;
	let image = await engine.decode(bytes, hint);
	const sourceWidth = image.width;
	const sourceHeight = image.height;
	const width = options.width && options.width > 0 ? Math.round(options.width) : image.width;
	const height = options.height && options.height > 0 ? Math.round(options.height) : image.height;
	if (width !== image.width || height !== image.height) {
		image = await engine.resize(image, { width, height });
	}
	const data = await engine.encode(image, options.format, {
		quality: clampQuality(options.quality)
	});
	return {
		name: suggestOutputName(options.name ?? 'image', options.format),
		data,
		format: options.format,
		width: image.width,
		height: image.height,
		sourceBytes: bytes.byteLength,
		sourceWidth,
		sourceHeight
	};
}

export async function estimateEncodedSize(
	engineId: EngineId,
	image: RasterImage,
	format: ImageFormat,
	quality?: number
): Promise<number> {
	const engine = await loadEngine(engineId);
	const data = await engine.encode(image, format, { quality: clampQuality(quality) });
	return data.byteLength;
}
