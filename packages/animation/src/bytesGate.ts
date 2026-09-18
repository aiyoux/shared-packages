/**
 * Re-exported from `@shared-packages/bytes-gate` (its real home since the
 * diagram session needed the same gate without depending on this package).
 * The public API of this package keeps exporting them so existing consumers
 * need no change.
 */
export {
	decideWrite,
	fingerprintBytes,
	fingerprintText,
	type WriteDecision
} from '@shared-packages/bytes-gate';