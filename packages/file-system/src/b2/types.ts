/**
 * Hub-only B2 connection profile.
 * Secret is plaintext in IDB unless the connection vault is enabled or
 * `persistSecret` is false (tab-only).
 * @see docs/design/b2-file-explorer-connection.md
 */

import { looksLikeMasterApplicationKeyId, masterKeyIdError } from './keyScope.js';
import type { SealedSecret } from '../vault/types.js';

export const HUB_B2_DB_NAME = 'HubB2';
export const HUB_B2_STORE = 'profiles';
export const HUB_B2_META = 'meta';

export type B2ConnectionProfileV1 = {
	/** Schema version */
	v: 1;
	/** Profile id (uuid) */
	id: string;
	/** Display name */
	name: string;
	applicationKeyId: string;
	/**
	 * Secret application key — never log.
	 * Empty when sealed, vault-locked, or session-only and this tab has no copy.
	 */
	applicationKey: string;
	bucketName: string;
	/**
	 * Optional key namePrefix restriction (matches limited app key).
	 * Normalized with trailing `/` when non-empty.
	 */
	namePrefix?: string;
	/** False = keep the key in this tab only (never write it to IndexedDB). Default true. */
	persistSecret?: boolean;
	/** Present when the connection vault has wrapped `applicationKey`. */
	sealedApplicationKey?: SealedSecret;
	createdAt: number;
	updatedAt: number;
};

export type HubB2Meta = {
	activeProfileId: string | null;
};

export function normalizeNamePrefix(raw?: string | null): string {
	const t = (raw ?? '').trim();
	if (!t) return '';
	return t.endsWith('/') ? t : `${t}/`;
}

export function validateProfileInput(input: {
	name: string;
	applicationKeyId: string;
	applicationKey: string;
	bucketName: string;
	namePrefix?: string;
	/** When false, empty applicationKey is allowed (keep existing). Default true. */
	requireApplicationKey?: boolean;
}): string | null {
	if (!input.name.trim()) return 'Name is required';
	if (!input.applicationKeyId.trim()) return 'Application key ID is required';
	if (looksLikeMasterApplicationKeyId(input.applicationKeyId)) return masterKeyIdError();
	if (input.requireApplicationKey !== false && !input.applicationKey.trim()) {
		return 'Application key is required';
	}
	if (!input.bucketName.trim()) return 'Bucket name is required';
	if (input.bucketName.includes('/')) return 'Bucket name must not contain /';
	return null;
}
