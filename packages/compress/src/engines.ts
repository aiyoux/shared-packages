import { createEngineRegistry } from '@shared-packages/ui/engines';
import { ENGINE_CATALOG, type CompressionEngine, type EngineId, type EngineInfo } from './types.js';

/** Load one engine (and its library / WASM) on demand. Cached after first call. */
export const { listEngines, loadEngine, peekEngine } = createEngineRegistry<EngineId, CompressionEngine, EngineInfo>({
	kind: 'compression',
	catalog: ENGINE_CATALOG,
	loaders: {
		fflate: async () => (await import('./engines/fflate.js')).fflateEngine,
		zipkit: async () => (await import('./engines/zipkit.js')).zipkitEngine,
		addmaple: async () => (await import('./engines/addmaple.js')).addmapleEngine,
		tarjs: async () => (await import('./engines/tarjs.js')).tarjsEngine,
		nanotar: async () => (await import('./engines/nanotar.js')).nanotarEngine,
		zipjs: async () => (await import('./engines/zipjs.js')).zipjsEngine,
		libarchive: async () => (await import('./engines/libarchive.js')).libarchiveEngine
	},
	prepare: (engine) => engine.load()
});
