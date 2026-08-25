/**
 * In-memory vault session: wrapping key (when unlocked) + tab-only secrets.
 */
import type { SecretKind } from './types.js';

let wrappingKey: Uint8Array | null = null;
const sessionSecrets = new Map<string, string>();

export function sessionSecretId(kind: SecretKind, id: string): string {
	return `${kind}:${id}`;
}

export function setWrappingKey(key: Uint8Array): void {
	wrappingKey = key;
}

export function getWrappingKey(): Uint8Array | null {
	return wrappingKey;
}

export function clearWrappingKey(): void {
	if (wrappingKey) wrappingKey.fill(0);
	wrappingKey = null;
}

export function isVaultUnlocked(): boolean {
	return wrappingKey !== null;
}

export function setSessionSecret(kind: SecretKind, id: string, secret: string): void {
	sessionSecrets.set(sessionSecretId(kind, id), secret);
}

export function getSessionSecret(kind: SecretKind, id: string): string {
	return sessionSecrets.get(sessionSecretId(kind, id)) ?? '';
}

export function clearSessionSecret(kind: SecretKind, id: string): void {
	sessionSecrets.delete(sessionSecretId(kind, id));
}

const sessionListeners = new Set<() => void>();

/** Same-tab vault lock/unlock/enable (BroadcastChannel does not echo to the poster). */
export function subscribeVaultSession(listener: () => void): () => void {
	sessionListeners.add(listener);
	return () => {
		sessionListeners.delete(listener);
	};
}

export function notifyVaultSession(): void {
	for (const fn of sessionListeners) {
		try {
			fn();
		} catch {
			/* ignore */
		}
	}
}

export function resetVaultSessionForTests(): void {
	clearWrappingKey();
	sessionSecrets.clear();
	sessionListeners.clear();
}
