export type VideoInterpolatorStatus = {
	rifePath?: string;
	/** Why there is no path: no pick, a dead pick, or not installed (with steps). */
	rifeError?: string;
};

export type VideoInterpolator = {
	checkStatus: () => Promise<VideoInterpolatorStatus>;
	newJobId: () => string;
	pollProgress: (id: string, onProgress: (n: number) => void) => () => void;
	interpolate: (blob: Blob, opts: { fps: number; id: string }) => Promise<Blob>;
};

export type VideoUpscalerStatus = {
	srmdPath?: string;
	/** Why there is no path: no pick, a dead pick, or not installed (with steps). */
	srmdError?: string;
};

export type VideoUpscaler = {
	checkStatus: () => Promise<VideoUpscalerStatus>;
	newJobId: () => string;
	pollProgress: (id: string, onProgress: (n: number) => void) => () => void;
	upscale: (
		blob: Blob,
		opts: { scale: number; noise?: number; model?: string; id: string }
	) => Promise<Blob>;
};

export type VideoAudioUpscalerStatus = {
	audioPath?: string;
	/** Why there is no path: no pick or a dead pick. */
	audioError?: string;
	/** Engines to offer, in order; absent keeps the panel's LavaSR/NovaSR pair. */
	engines?: ReadonlyArray<{ id: string; label: string }>;
	/** The engine to preselect (the picked row's). */
	defaultEngine?: string;
	/** Engine id → why it cannot run here (install steps). */
	unavailable?: Record<string, string>;
};

/**
 * Audio upsampling on a monitor (tools-feature.md §3.4): bandwidth extension
 * to 48 kHz mono — a WAV for an audio-only input, an MP4 (the input's video
 * stream muxed back) when the input had video.
 */
export type VideoAudioUpscaler = {
	checkStatus: () => Promise<VideoAudioUpscalerStatus>;
	newJobId: () => string;
	pollProgress: (id: string, onProgress: (n: number) => void) => () => void;
	upsample: (
		blob: Blob,
		opts: { engine?: string; denoise?: boolean; id: string }
	) => Promise<Blob>;
};

export type EngineId = 'native';

export type VideoFormat = 'mp4' | 'webm' | 'gif';

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
	/** Encoder rate-control hint only; source PTS drives real output timing. */
	fpsHint?: number;
	/** Include the source's audio, decoded and re-encoded into the output. */
	audio?: { codec?: 'aac' | 'opus'; bitrate?: number };
	onProgress?: (progress: number) => void;
	/** Cancel signal: checked between frames; the export ends with an AbortError. */
	signal?: AbortSignal;
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
	}
] as const;

export const DEFAULT_ENGINE: EngineId = 'native';

export const FORMAT_LABEL: Record<VideoFormat, string> = {
	mp4: 'MP4 (H.264)',
	webm: 'WebM (VP8)',
	gif: 'GIF (animated)'
};

export const FORMAT_EXTENSION: Record<VideoFormat, string> = {
	mp4: '.mp4',
	webm: '.webm',
	gif: '.gif'
};

export const FORMAT_MIME: Record<VideoFormat, string> = {
	mp4: 'video/mp4',
	webm: 'video/webm',
	gif: 'image/gif'
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
