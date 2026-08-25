import { describe, expect, it } from 'vitest';
import {
	assertBucketScopedAuthorization,
	looksLikeMasterApplicationKeyId
} from './keyScope.js';
import { ExplorerB2Error } from './errors.js';
import type { AuthorizeAccountResponse } from '@backblaze-labs/b2-sdk';

describe('looksLikeMasterApplicationKeyId', () => {
	it('treats 12–24 hex account IDs as master keys', () => {
		expect(looksLikeMasterApplicationKeyId('4a48fe8875c6214141007211')).toBe(true);
		expect(looksLikeMasterApplicationKeyId('12f634bf4b6c')).toBe(true);
	});

	it('accepts application key IDs that start with 003', () => {
		expect(looksLikeMasterApplicationKeyId('0034a48fe8875c6214141007211000000001')).toBe(false);
	});

	it('does not flag test / non-hex ids', () => {
		expect(looksLikeMasterApplicationKeyId('test-key-id')).toBe(false);
		expect(looksLikeMasterApplicationKeyId('keyId')).toBe(false);
	});
});

function auth(partial: {
	bucketId?: string | null;
	bucketName?: string | null;
	buckets?: Array<{ id: string; name: string | null }> | null;
}): AuthorizeAccountResponse {
	return {
		accountId: 'acct',
		authorizationToken: 'tok',
		applicationKeyExpirationTimestamp: null,
		apiInfo: {
			storageApi: {
				absoluteMinimumPartSize: 1,
				apiUrl: 'https://api.backblazeb2.com',
				downloadUrl: 'https://f000.backblazeb2.com',
				infoType: 'storageApi',
				recommendedPartSize: 1,
				s3ApiUrl: 'https://s3.us-west-000.backblazeb2.com',
				bucketId: partial.bucketId ?? null,
				bucketName: partial.bucketName ?? null,
				namePrefix: null,
				allowed: {
					capabilities: [],
					buckets: partial.buckets ?? null,
					bucketId: partial.bucketId ?? null,
					bucketName: partial.bucketName ?? null,
					namePrefix: null
				}
			}
		}
	} as unknown as AuthorizeAccountResponse;
}

describe('assertBucketScopedAuthorization', () => {
	it('refuses keys with no bucket restriction', () => {
		expect(() => assertBucketScopedAuthorization(auth({}), 'photos')).toThrow(ExplorerB2Error);
		try {
			assertBucketScopedAuthorization(auth({}), 'photos');
		} catch (e) {
			expect((e as ExplorerB2Error).code).toBe('B2_MASTER_KEY');
		}
	});

	it('accepts a key limited to the profile bucket', () => {
		expect(() =>
			assertBucketScopedAuthorization(auth({ bucketId: 'b1', bucketName: 'photos' }), 'photos')
		).not.toThrow();
	});

	it('rejects a key limited to a different bucket', () => {
		expect(() =>
			assertBucketScopedAuthorization(auth({ bucketId: 'b1', bucketName: 'other' }), 'photos')
		).toThrow(/other/);
	});
});
