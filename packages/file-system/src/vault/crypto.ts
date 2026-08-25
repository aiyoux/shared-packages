/**
 * Wrap/unwrap connection secrets with the session wrapping key (Web Crypto AES-GCM).
 */
import { loadEngine, bytesToBase64url, base64urlToBytes } from '@shared-packages/crypto';
import { getWrappingKey } from './session.js';
import { VaultLockedError, type SealedSecret } from './types.js';

/** Same cost as `@shared-packages/crypto` webcrypto engine (not re-exported from the package index). */
const DEFAULT_PBKDF2_ITERATIONS = 600_000;

const AAD_PREFIX = 'hub-conn-vault-v1';
export const VERIFIER_PLAIN = 'hub-vault-ok';
export const VERIFIER_BINDING = 'verifier';

/** Production PBKDF2 cost. Tests override via {@link setVaultKdfCostForTests}. */
let kdfCost = DEFAULT_PBKDF2_ITERATIONS;

export function getVaultKdfCost(): number {
	return kdfCost;
}

export function setVaultKdfCostForTests(cost: number): void {
	kdfCost = cost;
}

function aadFor(binding: string): Uint8Array {
	return new TextEncoder().encode(`${AAD_PREFIX}:${binding}`);
}

export async function wrapSecret(plaintext: string, binding: string): Promise<SealedSecret> {
	const key = getWrappingKey();
	if (!key) throw new VaultLockedError();
	const engine = await loadEngine('webcrypto');
	const iv = engine.randomBytes(engine.nonceLength);
	const ct = await engine.encrypt(new TextEncoder().encode(plaintext), key, iv, aadFor(binding));
	return { v: 1, iv: bytesToBase64url(iv), ct: bytesToBase64url(ct) };
}

export async function unwrapSecret(sealed: SealedSecret, binding: string): Promise<string> {
	const key = getWrappingKey();
	if (!key) throw new VaultLockedError();
	const engine = await loadEngine('webcrypto');
	const iv = base64urlToBytes(sealed.iv);
	const ct = base64urlToBytes(sealed.ct);
	const pt = await engine.decrypt(ct, key, iv, aadFor(binding));
	return new TextDecoder().decode(pt);
}

export { bytesToBase64url, base64urlToBytes };
