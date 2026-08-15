export type VideoInterpolatorStatus = {
	rifePath?: string;
};

export type VideoInterpolator = {
	checkStatus: () => Promise<VideoInterpolatorStatus>;
	newJobId: () => string;
	pollProgress: (id: string, onProgress: (n: number) => void) => () => void;
	interpolate: (blob: Blob, opts: { fps: number; id: string }) => Promise<Blob>;
};

export type EngineId = 'native' | 'ffmpeg';

export type VideoFormat = 'mp4' | 'webm';

export type EngineInfo = {
	id: EngineId;
	label: string;
	description: string;
	formats: readonly VideoFormat[];
};

export interface ProcessOptions {
	start: number;
	end: number;
	width?: number;
	height?: number;
	bitrate: string;
	format?: VideoFormat;
	onProgress?: (progress: number) => void;
}

export interface VideoEngine {
	readonly info: EngineInfo;
	load(): Promise<void>;
	process(input: Blob, options: ProcessOptions): Promise<Blob>;
}

export const ENGINE_CATALOG: readonly EngineInfo[] = [
	{
		id: 'native',
		label: 'WebCodecs + mediabunny',
		description: 'Trim and re-encode H.264 MP4 in Chromium. No extra download.',
		formats: ['mp4']
	},
	{
		id: 'ffmpeg',
		label: 'FFmpeg (WASM)',
		description: 'Lazy FFmpeg core — MP4 or WebM, keeps audio. Loaded only when you pick it.',
		formats: ['mp4', 'webm']
	}
] as const;

export const DEFAULT_ENGINE: EngineId = 'native';

export const FORMAT_LABEL: Record<VideoFormat, string> = {
	mp4: 'MP4 (H.264)',
	webm: 'WebM (VP8)'
};

export const FORMAT_EXTENSION: Record<VideoFormat, string> = {
	mp4: '.mp4',
	webm: '.webm'
};

export const FORMAT_MIME: Record<VideoFormat, string> = {
	mp4: 'video/mp4',
	webm: 'video/webm'
};

export const DEFAULT_BITRATE = '1M';

export function engineInfo(id: EngineId): EngineInfo {
	const found = ENGINE_CATALOG.find((e) => e.id === id);
	if (!found) throw new Error(`Unknown video engine: ${id}`);
	return found;
}

export function engineSupports(id: EngineId, format: VideoFormat): boolean {
	return engineInfo(id).formats.includes(format);
}
