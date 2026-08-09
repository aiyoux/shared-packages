import { describe, it, expect } from 'vitest';
import { classifyError } from '@backblaze-labs/b2-sdk/errors';
import { formatB2ErrorMessage, mapB2Error } from './errors.js';

describe('B2 error display', () => {
	it('surfaces bad_auth_token even when B2 message is empty', () => {
		const e = classifyError({ status: 401, code: 'bad_auth_token', message: '' });
		expect(e.message).toBe(''); // SDK reality
		const formatted = formatB2ErrorMessage(e);
		expect(formatted.length).toBeGreaterThan(0);
		expect(formatted).toMatch(/bad_auth_token/i);

		const mapped = mapB2Error(e);
		expect(mapped.code).toBe('B2_AUTH');
		expect(mapped.message.trim().length).toBeGreaterThan(0);
		expect(mapped.message).toMatch(/application key|bad_auth_token/i);
	});

	it('never returns empty ExplorerB2Error message', () => {
		const mapped = mapB2Error(new Error(''));
		expect(mapped.message.trim().length).toBeGreaterThan(0);
	});
});
