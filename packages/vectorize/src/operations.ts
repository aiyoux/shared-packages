import { MAX_POTRACE_PIXELS, packImageData } from './pixels.js';
import { parsePalette, suggestSvgName, type TracerId, type TracerInfo, type VectorizedImage } from './types.js';
import { TRACER_CATALOG, type PotraceOptions, type VtracerOptions } from './types.js';

export type VectorizeOptions = {
	tracer: TracerId;
	name?: string;
	sourceBytes?: number;
	sourceWidth?: number;
	sourceHeight?: number;
	vtracer?: VtracerOptions;
	potrace?: PotraceOptions;
};

export function listTracers(): readonly TracerInfo[] {
	return TRACER_CATALOG;
}

export async function loadTracer(id: TracerId): Promise<void> {
	if (id === 'vtracer') {
		const { loadVtracer } = await import('./engines/vtracer.js');
		await loadVtracer();
		return;
	}
	const { loadPotrace } = await import('./engines/potrace.js');
	await loadPotrace();
}

export async function vectorizeImage(
	image: ImageData,
	options: VectorizeOptions
): Promise<VectorizedImage> {
	await loadTracer(options.tracer);
	let svg: string;
	let outW = image.width;
	let outH = image.height;
	if (options.tracer === 'vtracer') {
		const packed = packImageData(image);
		outW = packed.width;
		outH = packed.height;
		const { vectorizeWithVtracer } = await import('./engines/vtracer.js');
		const opts = { ...(options.vtracer ?? {}) };
		if (opts.palette && !Array.isArray(opts.palette)) {
			opts.palette = parsePalette(String(opts.palette));
		}
		svg = vectorizeWithVtracer(
			new Uint8Array(packed.data),
			packed.width,
			packed.height,
			opts
		);
	} else {
		const packed = packImageData(image, MAX_POTRACE_PIXELS);
		outW = packed.width;
		outH = packed.height;
		const { vectorizeWithPotrace } = await import('./engines/potrace.js');
		svg = await vectorizeWithPotrace(packed, options.potrace ?? {});
	}
	const data = new TextEncoder().encode(svg);
	return {
		name: suggestSvgName(options.name ?? 'image'),
		svg,
		data,
		width: outW,
		height: outH,
		sourceBytes: options.sourceBytes ?? data.byteLength,
		sourceWidth: options.sourceWidth ?? image.width,
		sourceHeight: options.sourceHeight ?? image.height,
		tracer: options.tracer
	};
}
