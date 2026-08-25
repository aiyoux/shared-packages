/**
 * Refuse Backblaze master / unscoped application keys.
 *
 * Master application key ID is the account ID (12–24 hex, no `003` prefix).
 * Bucket-scoped application keys are issued with IDs that start with `003`.
 * After authorize, `allowed.buckets` / `allowed.bucketId` must be present.
 */
import type { AuthorizeAccountResponse } from '@backblaze-labs/b2-sdk';
import { ExplorerB2Error } from './errors.js';

const MASTER_KEY_MESSAGE =
	'Master application keys are not allowed. Create a bucket-scoped application key in the Backblaze dashboard.';

const UNSCOPED_KEY_MESSAGE =
	'This application key is not limited to a bucket. Create a bucket-scoped key (and optional name prefix) in the Backblaze dashboard.';

/**
 * True when the key ID looks like a B2 account ID used as the master key ID.
 * Application key IDs issued by B2 start with `003`.
 */
export function looksLikeMasterApplicationKeyId(keyId: string): boolean {
	const id = keyId.trim();
	if (!id) return false;
	if (/^003[a-zA-Z0-9]+$/.test(id)) return false;
	return /^[a-fA-F0-9]{12,24}$/.test(id);
}

export function masterKeyIdError(): string {
	return MASTER_KEY_MESSAGE;
}

export function assertBucketScopedAuthorization(
	auth: AuthorizeAccountResponse,
	bucketName: string
): void {
	const allowed = auth.apiInfo?.storageApi?.allowed;
	if (!allowed) {
		throw new ExplorerB2Error('B2_MASTER_KEY', UNSCOPED_KEY_MESSAGE);
	}
	const buckets = allowed.buckets;
	const named =
		(typeof allowed.bucketName === 'string' && allowed.bucketName) ||
		buckets?.map((b) => b.name).find((n) => !!n) ||
		'';
	const scoped =
		(Array.isArray(buckets) && buckets.length > 0) ||
		!!allowed.bucketId ||
		!!allowed.bucketName;
	if (!scoped) {
		throw new ExplorerB2Error('B2_MASTER_KEY', UNSCOPED_KEY_MESSAGE);
	}
	if (named && bucketName && named !== bucketName) {
		throw new ExplorerB2Error(
			'B2_FORBIDDEN',
			`This key is limited to bucket "${named}", not "${bucketName}".`
		);
	}
}
