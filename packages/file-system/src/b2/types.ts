/**
 * Hub-only B2 connection profile (v1 plaintext credentials in IndexedDB).
 * @see docs/design/b2-file-explorer-connection.md
 */

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
	/** Secret application key — never log */
	applicationKey: string;
	bucketName: string;
	/**
	 * Optional key namePrefix restriction (matches limited app key).
	 * Normalized with trailing `/` when non-empty.
	 */
	namePrefix?: string;
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
}): string | null {
	if (!input.name.trim()) return 'Name is required';
	if (!input.applicationKeyId.trim()) return 'Application key ID is required';
	if (!input.applicationKey.trim()) return 'Application key is required';
	if (!input.bucketName.trim()) return 'Bucket name is required';
	if (input.bucketName.includes('/')) return 'Bucket name must not contain /';
	return null;
}
