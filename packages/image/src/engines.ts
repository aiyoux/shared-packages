import { createEngineRegistry } from '@shared-packages/ui/engines';
import { ENGINE_CATALOG, type EngineId, type ImageEngine, type EngineInfo } from './types.js';

/** Load one engine (and its WASM) on demand. Cached after first call. */
export const { listEngines, loadEngine, peekEngine } = createEngineRegistry<EngineId, ImageEngine, EngineInfo>({
	kind: 'image',
	catalog: ENGINE_CATALOG,
	loaders: {
		native: async () => (await import('./engines/native.js')).nativeEngine,
		jsquash: async () => (await import('./engines/jsquash.js')).jsquashEngine
	},
	prepare: (engine) => engine.load()
});
