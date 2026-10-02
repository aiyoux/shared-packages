import { createEngineRegistry } from '@shared-packages/ui/engines';
import { nativeEngine } from './engines/native.js';
import { ENGINE_CATALOG, type EngineId, type VideoEngine, type EngineInfo } from './types.js';

/** The WebCodecs engine, loaded on first use. */
export const { listEngines, loadEngine, peekEngine } = createEngineRegistry<EngineId, VideoEngine, EngineInfo>({
	kind: 'video',
	catalog: ENGINE_CATALOG,
	loaders: { native: async () => nativeEngine },
	prepare: (engine) => engine.load()
});
