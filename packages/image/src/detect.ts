import { FORMAT_EXTENSION, type ImageFormat } from './types.js';

export type DetectedImage = {
	format: ImageFormat;
	via: 'magic' | 'name';
};

export function detectFormatFromBytes(bytes: Uint8Array): DetectedImage | null {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return { format: 'jpeg', via: 'magic' };
	}
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	) {
		return { format: 'png', via: 'magic' };
	}
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return { format: 'webp', via: 'magic' };
	}
	return null;
}

export function detectFormatFromName(name: string): DetectedImage | null {
	const lower = name.toLowerCase();
	if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return { format: 'jpeg', via: 'name' };
	if (lower.endsWith('.png')) return { format: 'png', via: 'name' };
	if (lower.endsWith('.webp')) return { format: 'webp', via: 'name' };
	return null;
}

export function detectFormat(bytes: Uint8Array, name?: string): DetectedImage | null {
	return detectFormatFromBytes(bytes) ?? (name ? detectFormatFromName(name) : null);
}

export function extensionForFormat(format: ImageFormat): string {
	return FORMAT_EXTENSION[format];
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|svg|avif|bmp)$/i;

export function suggestOutputName(sourceName: string, format: ImageFormat): string {
	const base = sourceName.replace(IMAGE_EXT, '') || 'image';
	return `${base}${FORMAT_EXTENSION[format]}`;
}
