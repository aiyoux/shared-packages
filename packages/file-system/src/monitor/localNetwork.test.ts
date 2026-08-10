import { describe, expect, it } from 'vitest';
import { isLoopbackUrl, withLocalAddressSpace } from './localNetwork.js';

describe('isLoopbackUrl', () => {
	it('accepts loopback hosts in every spelling', () => {
		for (const url of [
			'http://127.0.0.1:8300',
			'http://127.0.0.1',
			'http://127.5.6.7:9847/v1/health',
			'http://localhost:8300',
			'http://LOCALHOST:8300',
			'http://foo.localhost:8300',
			'http://[::1]:8300',
			'http://monitor.local:8300'
		]) {
			expect(isLoopbackUrl(url), url).toBe(true);
		}
	});

	it('rejects public and private hosts', () => {
		// Public would *fail* if annotated as local, so it must not be.
		for (const url of [
			'https://monitor.example.com',
			'https://tools.codokie.com/v1/fs/list',
			// RFC1918 is a different address space; annotating it 'local' is wrong.
			'http://192.168.1.10:8300',
			'http://10.0.0.5:8300',
			'http://172.16.0.1:8300',
			'not a url',
			''
		]) {
			expect(isLoopbackUrl(url), url).toBe(false);
		}
	});
});

describe('withLocalAddressSpace', () => {
	it('annotates loopback requests and preserves the original init', () => {
		const signal = new AbortController().signal;
		const out = withLocalAddressSpace('http://127.0.0.1:8300/v1/fs/list', {
			method: 'GET',
			signal
		}) as RequestInit & { targetAddressSpace?: string };

		expect(out.targetAddressSpace).toBe('local');
		expect(out.method).toBe('GET');
		expect(out.signal).toBe(signal);
	});

	it('leaves non-loopback requests untouched', () => {
		const init = { method: 'POST' };
		const out = withLocalAddressSpace('https://monitor.example.com/v1/fs/list', init) as
			RequestInit & { targetAddressSpace?: string };

		expect(out.targetAddressSpace).toBeUndefined();
		expect(out).toBe(init);
	});

	it('defaults to an empty init', () => {
		const out = withLocalAddressSpace('http://localhost:8300') as
			RequestInit & { targetAddressSpace?: string };
		expect(out.targetAddressSpace).toBe('local');
	});
});
