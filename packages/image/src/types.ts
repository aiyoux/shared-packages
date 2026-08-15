export type EngineId = 'native' | 'jsquash';

export type ImageFormat = 'jpeg' | 'png' | 'webp';

export type RasterImage = {
	width: number;
	height: number;
	data: ImageData;
};

export type EncodeOptions = {
	/** 0–1. Used by JPEG and WebP. Ignored by PNG. */
	quality?: number;
};

export type ResizeOptions = {
	width: number;
	height: number;
};

export type EngineInfo = {
	id: EngineId;
	label: string;
	description: string;
	formats: readonly ImageFormat[];
};

export interface ImageEngine {
	readonly info: EngineInfo;
	load(): Promise<void>;
	decode(bytes: Uint8Array, hint?: ImageFormat | string): Promise<RasterImage>;
	encode(image: RasterImage, format: ImageFormat, options?: EncodeOptions): Promise<Uint8Array>;
	resize(image: RasterImage, options: ResizeOptions): Promise<RasterImage>;
}

export const ENGINE_CATALOG: readonly EngineInfo[] = [
	{
		id: 'native',
		label: 'In-browser native',
		description: 'Canvas and createImageBitmap — no extra download. JPEG, PNG, WebP.',
		formats: ['jpeg', 'png', 'webp']
	},
	{
		id: 'jsquash',
		label: 'jSquash (WASM)',
		description: 'MozJPEG, libwebp, and rust PNG/resize — loaded only when you pick this library.',
		formats: ['jpeg', 'png', 'webp']
	}
] as const;

export const DEFAULT_ENGINE: EngineId = 'native';

export const FORMAT_LABEL: Record<ImageFormat, string> = {
	jpeg: 'JPEG',
	png: 'PNG',
	webp: 'WebP'
};

export const FORMAT_EXTENSION: Record<ImageFormat, string> = {
	jpeg: '.jpg',
	png: '.png',
	webp: '.webp'
};

export const FORMAT_MIME: Record<ImageFormat, string> = {
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp'
};

export const DEFAULT_QUALITY = 0.8;

export function engineInfo(id: EngineId): EngineInfo {
	const found = ENGINE_CATALOG.find((e) => e.id === id);
	if (!found) throw new Error(`Unknown image engine: ${id}`);
	return found;
}

export function engineSupports(id: EngineId, format: ImageFormat): boolean {
	return engineInfo(id).formats.includes(format);
}

export function clampQuality(quality: number | undefined): number {
	if (quality === undefined || !Number.isFinite(quality)) return DEFAULT_QUALITY;
	return Math.min(1, Math.max(0.05, quality));
}

export function qualityUsesSlider(format: ImageFormat): boolean {
	return format === 'jpeg' || format === 'webp';
}
