import { loadEngine } from './engines.js';
import { bytesToHex, hexToBytes, timingSafeEqual, timingSafeEqualHex } from './hex.js';
import { engineSupportsHash, type EngineId, type HashAlg } from './types.js';

export type HashResult = {
	alg: HashAlg;
	engine: EngineId;
	bytes: Uint8Array;
	hex: string;
};

export async function hashBytes(
	engineId: EngineId,
	data: Uint8Array,
	alg: HashAlg
): Promise<HashResult> {
	if (!engineSupportsHash(engineId, alg)) {
		throw new Error(`${engineId} does not support ${alg}`);
	}
	const engine = await loadEngine(engineId);
	const bytes = await engine.hash(data, alg);
	return { alg, engine: engineId, bytes, hex: bytesToHex(bytes) };
}

export async function verifyHash(
	engineId: EngineId,
	data: Uint8Array,
	expectedHex: string,
	alg: HashAlg
): Promise<{ ok: boolean; actual: HashResult }> {
	const actual = await hashBytes(engineId, data, alg);
	let expected: Uint8Array;
	try {
		expected = hexToBytes(expectedHex);
	} catch {
		return { ok: false, actual };
	}
	return { ok: timingSafeEqual(actual.bytes, expected), actual };
}

export { bytesToHex, hexToBytes, timingSafeEqual, timingSafeEqualHex };
