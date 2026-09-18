/**
 * Content-addressed write gating — the W7a/W7b fingerprint kernel shared by
 * every op-reducer document (clip bytes in the animation package, whole
 * `.digr`/`.anim` sessions in the hub).
 *
 * Lives in its own package because two app-agnostic packages need it and
 * neither should depend on the other: the animation package (whose clips
 * embed bytes) and the document-session factory in file-system both gate
 * writes on "has anything actually changed".
 */
export {
	decideWrite,
	fingerprintBytes,
	fingerprintText,
	type WriteDecision
} from './bytesGate.js';