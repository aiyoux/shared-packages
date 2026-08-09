import { describe, it, expect } from 'vitest';
import {
	assertB2ControlPlaneUrl,
	isB2ControlPlaneUrl,
	isB2DataPlaneUrl
} from './controlPlane.js';

describe('B2 control-plane classification', () => {
	it('classifies authorize and storage API hosts as control plane', () => {
		expect(isB2ControlPlaneUrl('https://api.backblazeb2.com/b2api/v4/b2_authorize_account')).toBe(
			true
		);
		expect(
			isB2ControlPlaneUrl('https://api001.backblazeb2.com/b2api/v3/b2_list_file_names')
		).toBe(true);
		expect(isB2ControlPlaneUrl('https://api999.backblazeb2.com/b2api/v3/b2_get_upload_url')).toBe(
			true
		);
	});

	it('does not treat download or upload hosts as control plane', () => {
		expect(isB2ControlPlaneUrl('https://f000.backblazeb2.com/file/bucket/x')).toBe(false);
		expect(
			isB2ControlPlaneUrl('https://pod-000-1000-00.backblaze.com/b2api/v2/b2_upload_file/abc')
		).toBe(false);
		expect(isB2ControlPlaneUrl('https://s3.us-west-004.backblazeb2.com/bucket/key')).toBe(false);
	});

	it('classifies data-plane hosts for direct browser I/O', () => {
		expect(isB2DataPlaneUrl('https://f004.backblazeb2.com/file/b/name')).toBe(true);
		expect(isB2DataPlaneUrl('https://pod-000-1000-00.backblaze.com/b2api/v2/b2_upload_file/x')).toBe(
			true
		);
		expect(isB2DataPlaneUrl('https://api.backblazeb2.com/b2api/v4/b2_authorize_account')).toBe(
			false
		);
	});

	it('assertB2ControlPlaneUrl rejects SSRF-ish targets', () => {
		expect(() => assertB2ControlPlaneUrl('http://api.backblazeb2.com/x')).toThrow(/https/);
		expect(() => assertB2ControlPlaneUrl('https://evil.com/x')).toThrow(/control-plane/);
		expect(() => assertB2ControlPlaneUrl('https://f000.backblazeb2.com/file/b/x')).toThrow(
			/control-plane/
		);
		expect(() => assertB2ControlPlaneUrl('https://127.0.0.1/x')).toThrow();
		expect(assertB2ControlPlaneUrl('https://api.backblazeb2.com/b2api/v4/b2_authorize_account').host).toBe(
			'api.backblazeb2.com'
		);
	});
});
