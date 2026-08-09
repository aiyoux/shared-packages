import { describe, it, expect } from 'vitest';
import {
	ExplorerRcloneError,
	formatRcloneErrorMessage,
	mapRcloneError,
	scrubSecrets
} from './errors.js';

describe('rclone errors', () => {
	it('maps 401 to RCLONE_AUTH with non-empty message', () => {
		const e = Object.assign(new Error(''), { status: 401 });
		const mapped = mapRcloneError(e);
		expect(mapped.code).toBe('RCLONE_AUTH');
		expect(mapped.message.trim().length).toBeGreaterThan(0);
	});

	it('maps 404 / not found', () => {
		const e = Object.assign(new Error('not found'), { status: 404 });
		expect(mapRcloneError(e).code).toBe('RCLONE_NOT_FOUND');
	});

	it('maps 429 to rate limit', () => {
		const e = Object.assign(new Error('slow down'), { status: 429 });
		expect(mapRcloneError(e).code).toBe('RCLONE_RATE_LIMIT');
	});

	it('never returns empty ExplorerRcloneError message', () => {
		const mapped = mapRcloneError(new Error(''));
		expect(mapped.message.trim().length).toBeGreaterThan(0);
	});

	it('scrubs Authorization-like material from messages', () => {
		const raw = 'failed Authorization: Basic dXNlcjpwYXNz and rcPass=secret';
		const scrubbed = scrubSecrets(raw);
		expect(scrubbed.toLowerCase()).not.toContain('dXNlcjpwYXNz');
		expect(scrubbed.toLowerCase()).not.toMatch(/rcpass=secret/);
		expect(formatRcloneErrorMessage(new Error(raw))).not.toMatch(/Basic dXNlcj/);
	});

	it('preserves ExplorerRcloneError', () => {
		const e = new ExplorerRcloneError('RCLONE_TOO_LARGE', 'cap');
		expect(mapRcloneError(e)).toBe(e);
	});
});
