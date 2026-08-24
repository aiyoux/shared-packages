import { packImageData } from './pixels.js';
import { parsePalette, suggestSvgName, type TracerId, type TracerInfo, type VectorizedImage } from './types.js';
import { TRACER_CATALOG, type VtracerOptions } from './types.js';

export type VectorizeOptions = {
	tracer: TracerId;
	name?: string;
	sourceBytes?: number;
	sourceWidth?: number;
	sourceHeight?: number;
	vtracer?: VtracerOptions;
};

export function listTracers(): readonly TracerInfo[] {
	return TRACER_CATALOG;
}

export async function loadTracer(id: TracerId): Promise<void> {
	if (id !== 'vtracer') throw new Error(`Unknown tracer: ${id}`);
	const { loadVtracer } = await import('./engines/vtracer.js');
	await loadVtracer();
}

export async function vectorizeImage(
	image: ImageData,
	options: VectorizeOptions
): Promise<VectorizedImage> {
	await loadTracer(options.tracer);
	const packed = packImageData(image);
	const opts = { ...(options.vtracer ?? {}) };
	if (opts.palette && !Array.isArray(opts.palette)) {
		opts.palette = parsePalette(String(opts.palette));
	}
	const { vectorizeWithVtracer } = await import('./engines/vtracer.js');
	const svg = vectorizeWithVtracer(
		new Uint8Array(packed.data),
		packed.width,
		packed.height,
		opts
	);
	const data = new TextEncoder().encode(svg);
	return {
		name: suggestSvgName(options.name ?? 'image'),
		svg,
		data,
		width: packed.width,
		height: packed.height,
		sourceBytes: options.sourceBytes ?? data.byteLength,
		sourceWidth: options.sourceWidth ?? image.width,
		sourceHeight: options.sourceHeight ?? image.height,
		tracer: options.tracer
	};
}
