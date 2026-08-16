import { parseBitrate } from '../encodeSession.js';
import { engineInfo, type ProcessOptions, type VideoEngine } from '../types.js';

/** Official single-thread core — loaded from a CDN so the hub worker is not 30MB. */
const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';

type FfmpegMod = typeof import('@ffmpeg/ffmpeg');
type UtilMod = typeof import('@ffmpeg/util');

let ffmpeg: InstanceType<FfmpegMod['FFmpeg']> | null = null;
let fetchFile: UtilMod['fetchFile'] | null = null;

function even(n: number): number {
	return Math.max(2, Math.floor(n / 2) * 2);
}

function inputName(blob: Blob): string {
	const type = blob.type.toLowerCase();
	if (type.includes('webm')) return 'input.webm';
	if (type.includes('quicktime') || type.includes('mov')) return 'input.mov';
	if (type.includes('matroska')) return 'input.mkv';
	return 'input.mp4';
}

export const ffmpegEngine: VideoEngine = {
	info: engineInfo('ffmpeg'),

	async load() {
		if (ffmpeg) return;
		const [{ FFmpeg }, util] = await Promise.all([
			import('@ffmpeg/ffmpeg'),
			import('@ffmpeg/util')
		]);
		const instance = new FFmpeg();
		const { toBlobURL } = util;
		await instance.load({
			coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
			wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm')
		});
		ffmpeg = instance;
		fetchFile = util.fetchFile;
	},

	async process(input, options: ProcessOptions) {
		if (!ffmpeg || !fetchFile) await this.load();
		const ff = ffmpeg!;
		const fetch = fetchFile!;
		const format = options.format ?? 'mp4';
		const inName = inputName(input);
		const outName = format === 'webm' ? 'out.webm' : 'out.mp4';

		const onProgress = (ev: { progress: number }) => {
			if (!options.onProgress) return;
			const pct = Math.min(100, Math.max(0, Math.round((ev.progress || 0) * 100)));
			options.onProgress(pct);
		};
		ff.on('progress', onProgress);

		try {
			await ff.writeFile(inName, await fetch(input));
			const args = ['-hide_banner', '-y', '-ss', String(options.start), '-to', String(options.end), '-i', inName];
			if (options.width && options.height) {
				args.push('-vf', `scale=${even(options.width)}:${even(options.height)}`);
			}
			const bits = parseBitrate(options.bitrate);
			if (format === 'webm') {
				args.push('-c:v', 'libvpx', '-b:v', String(bits), '-c:a', 'libvorbis', outName);
			} else {
				args.push(
					'-c:v',
					'libx264',
					'-pix_fmt',
					'yuv420p',
					'-b:v',
					String(bits),
					'-c:a',
					'aac',
					'-movflags',
					'+faststart',
					outName
				);
			}

			try {
				await ff.exec(args);
			} catch (first) {
				if (format !== 'mp4') throw first;
				// Some @ffmpeg/core builds omit libx264 — mpeg4 is always there.
				const fallback = [
					'-hide_banner',
					'-y',
					'-ss',
					String(options.start),
					'-to',
					String(options.end),
					'-i',
					inName,
					...(options.width && options.height
						? ['-vf', `scale=${even(options.width)}:${even(options.height)}`]
						: []),
					'-c:v',
					'mpeg4',
					'-b:v',
					String(bits),
					'-c:a',
					'aac',
					outName
				];
				await ff.exec(fallback);
			}

			const data = await ff.readFile(outName);
			const raw = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
			const copy = new Uint8Array(raw.byteLength);
			copy.set(raw);
			return new Blob([copy.buffer], { type: format === 'webm' ? 'video/webm' : 'video/mp4' });
		} finally {
			ff.off('progress', onProgress);
			try {
				await ff.deleteFile(inName);
			} catch {
				/* ignore */
			}
			try {
				await ff.deleteFile(outName);
			} catch {
				/* ignore */
			}
		}
	}
};
