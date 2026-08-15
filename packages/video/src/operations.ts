import { loadEngine } from './engines.js';
import { suggestOutputName } from './detect.js';
import {
	DEFAULT_BITRATE,
	type EngineId,
	type ProcessOptions,
	type VideoFormat
} from './types.js';

export type ExportOptions = ProcessOptions & {
	format: VideoFormat;
	name?: string;
};

export type ExportedVideo = {
	name: string;
	blob: Blob;
	format: VideoFormat;
	bytes: number;
};

export async function exportVideo(
	engineId: EngineId,
	input: Blob,
	options: ExportOptions
): Promise<ExportedVideo> {
	const engine = await loadEngine(engineId);
	const blob = await engine.process(input, {
		...options,
		bitrate: options.bitrate || DEFAULT_BITRATE
	});
	return {
		name: suggestOutputName(options.name ?? 'video', options.format),
		blob,
		format: options.format,
		bytes: blob.size
	};
}
