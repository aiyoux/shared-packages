/**
 * Content-addressed write gating for clip bytes.
 *
 * A resolver that keeps producing identical output must stop writing, or every
 * effect reading its output re-fires forever. This is the intra-tab half of
 * that guard (W7a); the save boundary is the cross-tab half (W7b). Both are
 * convergence, not detection — which is what makes them the only guards that
 * work across JS realms.
 *
 * Lives here rather than in either app because both need it and neither can
 * import the other.
 */

/**
 * djb2-ish, length-prefixed. Deliberately synchronous and dependency-free:
 * `crypto.subtle` is async and would make the save path async with it.
 * Equality is all that is asked of it — this is not a security hash.
 */
export function fingerprintBytes(bytes: Uint8Array): string {
	let h = bytes.byteLength >>> 0;
	for (let i = 0; i < bytes.length; i++) h = (Math.imul(h, 33) + bytes[i]!) >>> 0;
	return `${bytes.byteLength}:${h.toString(16)}`;
}

/** Same, for an already-serialized document. */
export function fingerprintText(text: string): string {
	let h = text.length >>> 0;
	for (let i = 0; i < text.length; i++) h = (Math.imul(h, 33) + text.charCodeAt(i)) >>> 0;
	return `${text.length}:${h.toString(16)}`;
}

export type WriteDecision = { write: boolean; fingerprint: string };

/**
 * Whether new bytes differ from what was last written.
 *
 * `hasValue` distinguishes "same fingerprint, output already present" from
 * "same fingerprint but the output was dropped" (a revoked object URL, a
 * cleared map) — without it, a cache eviction would be silently permanent.
 *
 * The length prefix lets a differing length skip the hash entirely, which
 * matters where writing is cheap (an object URL) and hashing is not.
 */
export function decideWrite(
	previous: string | undefined,
	bytes: Uint8Array,
	hasValue = true
): WriteDecision {
	if (previous && hasValue && !previous.startsWith(`${bytes.byteLength}:`)) {
		return { write: true, fingerprint: fingerprintBytes(bytes) };
	}
	const fingerprint = fingerprintBytes(bytes);
	return { write: !(previous === fingerprint && hasValue), fingerprint };
}
