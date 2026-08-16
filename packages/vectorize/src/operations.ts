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
	if (options.tracer === 'vtracer') {
		const { vectorizeWithVtracer } = await import('./engines/vtracer.js');
		const opts = { ...(options.vtracer ?? {}) };
		if (opts.palette && !Array.isArray(opts.palette)) {
			opts.palette = parsePalette(String(opts.palette));
		}
		svg = vectorizeWithVtracer(
			new Uint8Array(image.data.buffer.slice(0)),
			image.width,
			image.height,
			opts
		);
	} else {
		const { vectorizeWithPotrace } = await import('./engines/potrace.js');
		svg = await vectorizeWithPotrace(image, options.potrace ?? {});
	}
	const data = new TextEncoder().encode(svg);
	return {
		name: suggestSvgName(options.name ?? 'image'),
		svg,
		data,
		width: image.width,
		height: image.height,
		sourceBytes: options.sourceBytes ?? data.byteLength,
		sourceWidth: options.sourceWidth ?? image.width,
		sourceHeight: options.sourceHeight ?? image.height,
		tracer: options.tracer
	};
}
