import { describe, it, expect } from 'vitest';
import {
	assertRcloneProxyTargetUrl,
	isAllowedRcMethod,
	RCLONE_ALLOWED_RC_METHODS
} from './rcAllowlist.js';

describe('rcAllowlist', () => {
	it('allows loopback:7750 only', () => {
		expect(assertRcloneProxyTargetUrl('http://127.0.0.1:7750').ok).toBe(true);
		expect(assertRcloneProxyTargetUrl('http://localhost:7750').ok).toBe(true);
		expect(assertRcloneProxyTargetUrl('http://evil.com:7750').ok).toBe(false);
		expect(assertRcloneProxyTargetUrl('http://169.254.169.254/').ok).toBe(false);
		expect(assertRcloneProxyTargetUrl('http://127.0.0.1:22').ok).toBe(false);
		expect(assertRcloneProxyTargetUrl('http://127.0.0.1:80').ok).toBe(false);
		expect(assertRcloneProxyTargetUrl('file:///etc/passwd').ok).toBe(false);
		expect(assertRcloneProxyTargetUrl('http://user:pass@127.0.0.1:7750').ok).toBe(false);
	});

	it('allows listed RC methods and denies dangerous ones', () => {
		expect(isAllowedRcMethod('operations/list')).toBe(true);
		expect(isAllowedRcMethod('rc/noopauth')).toBe(true);
		expect(isAllowedRcMethod('core/command')).toBe(false);
		expect(isAllowedRcMethod('config/dump')).toBe(false);
		expect(isAllowedRcMethod('config/create')).toBe(false);
		expect(isAllowedRcMethod('config/password')).toBe(false);
		expect(isAllowedRcMethod('backend/command')).toBe(false);
		expect(isAllowedRcMethod('sync/copy')).toBe(false);
		expect(isAllowedRcMethod('job/list')).toBe(false);
		expect(RCLONE_ALLOWED_RC_METHODS.has('operations/uploadfile')).toBe(true);
	});
});
