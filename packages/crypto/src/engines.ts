import { ENGINE_CATALOG, type CryptoEngine, type EngineId, type EngineInfo } from './types.js';

const cache = new Map<EngineId, CryptoEngine>();

export function listEngines(): readonly EngineInfo[] {
	return ENGINE_CATALOG;
}

export async function loadEngine(id: EngineId): Promise<CryptoEngine> {
	const hit = cache.get(id);
	if (hit) return hit;

	let engine: CryptoEngine;
	if (id === 'webcrypto') {
		const { webcryptoEngine } = await import('./engines/webcrypto.js');
		engine = webcryptoEngine;
	} else if (id === 'libsodium') {
		const { sodiumEngine } = await import('./engines/libsodium.js');
		engine = sodiumEngine;
	} else {
		throw new Error(`Unknown crypto engine: ${id}`);
	}

	await engine.load();
	cache.set(id, engine);
	return engine;
}

export function peekEngine(id: EngineId): CryptoEngine | null {
	return cache.get(id) ?? null;
}
