import { FORMAT_EXTENSION, type VideoFormat } from './types.js';

export function detectFormatFromName(name: string): VideoFormat | null {
	const lower = name.toLowerCase();
	if (lower.endsWith('.webm')) return 'webm';
	if (lower.endsWith('.mp4') || lower.endsWith('.m4v') || lower.endsWith('.mov')) return 'mp4';
	return null;
}

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv|avi)$/i;

export function suggestOutputName(sourceName: string, format: VideoFormat): string {
	const base = sourceName.replace(VIDEO_EXT, '') || 'video';
	return `${base}${FORMAT_EXTENSION[format]}`;
}
