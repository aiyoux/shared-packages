import { describe, it, expect } from 'vitest';
import {
	B2_EXPLORER_CORS_RULE,
	corsAllowsBrowserFileIo,
	mergeExplorerCorsRules,
	originAllowedByRule
} from './b2Cors.js';

describe('B2 explorer CORS', () => {
	it('matches exact origin, https, and *', () => {
		expect(originAllowedByRule('http://127.0.0.1:7990', 'http://127.0.0.1:7990')).toBe(true);
		expect(originAllowedByRule('https', 'https://tools.example')).toBe(true);
		expect(originAllowedByRule('https', 'http://127.0.0.1:7990')).toBe(false);
		expect(originAllowedByRule('*', 'http://localhost:7990')).toBe(true);
	});

	it('does not treat https-only rules as enough for local http upload', () => {
		expect(
			corsAllowsBrowserFileIo(
				[
					{
						corsRuleName: 'https-only',
						allowedOrigins: ['https'],
						allowedOperations: [
							'b2_upload_file',
							'b2_upload_part',
							'b2_download_file_by_name',
							'b2_download_file_by_id'
						],
						allowedHeaders: ['authorization', 'content-type', 'x-bz-file-name', 'x-bz-content-sha1'],
						exposeHeaders: null,
						maxAgeSeconds: 3600
					}
				],
				'http://127.0.0.1:7990'
			)
		).toBe(false);
	});

	it('merges a new rule for the page origin', () => {
		const { next, changed } = mergeExplorerCorsRules([], 'http://127.0.0.1:7990');
		expect(changed).toBe(true);
		expect(next).toHaveLength(1);
		expect(next[0]!.corsRuleName).toBe(B2_EXPLORER_CORS_RULE);
		expect(next[0]!.allowedOrigins).toEqual(['http://127.0.0.1:7990']);
		expect(next[0]!.allowedOperations).toContain('b2_upload_file');
	});

	it('is a no-op when the origin is already covered', () => {
		const first = mergeExplorerCorsRules([], 'http://127.0.0.1:7990').next;
		const again = mergeExplorerCorsRules(first, 'http://127.0.0.1:7990');
		expect(again.changed).toBe(false);
	});
});
