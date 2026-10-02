import { createEngineRegistry } from '@shared-packages/ui/engines';
import { ENGINE_CATALOG, type CryptoEngine, type EngineId, type EngineInfo } from './types.js';

export const { listEngines, loadEngine, peekEngine } = createEngineRegistry<EngineId, CryptoEngine, EngineInfo>({
	kind: 'crypto',
	catalog: ENGINE_CATALOG,
	loaders: {
		webcrypto: async () => (await import('./engines/webcrypto.js')).webcryptoEngine,
		libsodium: async () => (await import('./engines/libsodium.js')).sodiumEngine
	},
	prepare: (engine) => engine.load()
});
