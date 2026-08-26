import { processVideo } from '../process.js';
import { engineInfo, type ProcessOptions, type VideoEngine } from '../types.js';

export const nativeEngine: VideoEngine = {
	info: engineInfo('native'),

	async load() {
		if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
			throw new Error('WebCodecs is not available in this browser');
		}
	},

	async process(input, options: ProcessOptions) {
		if (options.format && options.format !== 'mp4') {
			throw new Error('WebCodecs export is MP4 only.');
		}
		return processVideo(input, options);
	}
};
