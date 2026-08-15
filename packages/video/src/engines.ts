import { ENGINE_CATALOG, type EngineId, type EngineInfo, type VideoEngine } from './types.js';

const cache = new Map<EngineId, VideoEngine>();

export function listEngines(): readonly EngineInfo[] {
	return ENGINE_CATALOG;
}

/** Load one engine (and FFmpeg WASM) on demand. Cached after first call. */
export async function loadEngine(id: EngineId): Promise<VideoEngine> {
	const hit = cache.get(id);
	if (hit) return hit;

	let engine: VideoEngine;
	if (id === 'native') {
		const { nativeEngine } = await import('./engines/native.js');
		engine = nativeEngine;
	} else if (id === 'ffmpeg') {
		const { ffmpegEngine } = await import('./engines/ffmpeg.js');
		engine = ffmpegEngine;
	} else {
		throw new Error(`Unknown video engine: ${id}`);
	}

	await engine.load();
	cache.set(id, engine);
	return engine;
}

export function peekEngine(id: EngineId): VideoEngine | null {
	return cache.get(id) ?? null;
}
