import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { httpDownloadIsSafe, mediaSrcIsEmbeddable } from '../src/ui/saveToDisk.ts';

describe('httpDownloadIsSafe', () => {
	it('allows https remotes and same-origin', () => {
		assert.equal(
			httpDownloadIsSafe(
				'https://f000.backblazeb2.com/file/b/x',
				'https://app.example/tools/files'
			),
			true
		);
		assert.equal(
			httpDownloadIsSafe('https://app.example/api/file', 'https://app.example/tools/files'),
			true
		);
	});

	it('allows loopback HTTP from an https page (mixed-content exemption)', () => {
		assert.equal(
			httpDownloadIsSafe(
				'http://127.0.0.1:8300/v1/fs/read?path=/tmp/a',
				'https://hub.example/tools/files'
			),
			true
		);
		assert.equal(
			httpDownloadIsSafe(
				'http://localhost:8300/v1/fs/read?path=/tmp/a',
				'https://hub.example/tools/files'
			),
			true
		);
	});

	it('rejects HTTP LAN from an https page (mixed content)', () => {
		assert.equal(
			httpDownloadIsSafe(
				'http://192.168.1.50:8300/v1/fs/read?path=/tmp/a',
				'https://hub.example/tools/files'
			),
			false
		);
	});

	it('allows HTTP LAN from an http page', () => {
		assert.equal(
			httpDownloadIsSafe(
				'http://192.168.1.50:8300/v1/fs/read?path=/tmp/a',
				'http://192.168.1.9:7990/tools/files'
			),
			true
		);
	});
});

describe('mediaSrcIsEmbeddable', () => {
	it('allows blob and data URLs', () => {
		assert.equal(mediaSrcIsEmbeddable('blob:http://127.0.0.1:7990/abc'), true);
		assert.equal(mediaSrcIsEmbeddable('data:image/png;base64,aaa'), true);
	});

	it('allows same-origin http', () => {
		assert.equal(
			mediaSrcIsEmbeddable(
				'http://127.0.0.1:7990/_app/img.png',
				'http://127.0.0.1:7990/tools/files'
			),
			true
		);
	});

	it('rejects monitor loopback on another port (CSP img-src self)', () => {
		assert.equal(
			mediaSrcIsEmbeddable(
				'http://127.0.0.1:8300/v1/fs/read?path=%2Fhome%2Fissue.png&download=issue.png',
				'http://127.0.0.1:7990/tools/files'
			),
			false
		);
	});

	it('rejects B2 HTTPS (not same origin)', () => {
		assert.equal(
			mediaSrcIsEmbeddable(
				'https://f000.backblazeb2.com/file/b/x',
				'https://app.example/tools/files'
			),
			false
		);
	});
});
