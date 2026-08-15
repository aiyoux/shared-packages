import { describe, it, expect } from 'vitest';
import { assertB2DataPlaneRelayUrl, handleB2DataPlaneRelay } from './dataPlaneRelay.js';

describe('B2 data-plane relay', () => {
	it('allows upload pods and download hosts', () => {
		expect(
			assertB2DataPlaneRelayUrl('https://pod-000-1000-00.backblaze.com/b2api/v2/b2_upload_file/x')
				.hostname
		).toBe('pod-000-1000-00.backblaze.com');
		expect(assertB2DataPlaneRelayUrl('https://f004.backblazeb2.com/file/b/n').hostname).toBe(
			'f004.backblazeb2.com'
		);
	});

	it('rejects control-plane and non-B2 hosts', () => {
		expect(() => assertB2DataPlaneRelayUrl('https://api.backblazeb2.com/b2api/v3/x')).toThrow(
			/upload\/download/
		);
		expect(() => assertB2DataPlaneRelayUrl('https://evil.example/x')).toThrow(/upload\/download/);
		expect(() => assertB2DataPlaneRelayUrl('http://127.0.0.1/x')).toThrow();
	});

	it('returns 400 for a missing target', async () => {
		const res = await handleB2DataPlaneRelay({
			url: '',
			method: 'POST',
			headers: new Headers(),
			body: null
		});
		expect(res.status).toBe(400);
	});
});
