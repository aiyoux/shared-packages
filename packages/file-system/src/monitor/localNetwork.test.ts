import { describe, expect, it } from 'vitest';
import { addressSpaceFor, isLoopbackUrl, withLocalAddressSpace } from './localNetwork.js';

describe('addressSpaceFor', () => {
	it('classifies loopback hosts as `loopback`, not `local`', () => {
		// Declaring `local` for these fails outright:
		// "target IP address space of `local` yet the resource is in `loopback`".
		for (const url of [
			'http://127.0.0.1:8300',
			'http://127.0.0.1',
			'http://127.5.6.7:9847/v1/health',
			'http://localhost:8300',
			'http://LOCALHOST:8300',
			'http://foo.localhost:8300',
			'http://[::1]:8300'
		]) {
			expect(addressSpaceFor(url), url).toBe('loopback');
		}
	});

	it('classifies local-network hosts as `local`', () => {
		for (const url of [
			'http://monitor.local:8300',
			'http://192.168.1.10:8300',
			'http://10.0.0.5:8300',
			'http://172.16.0.1:8300',
			'http://172.31.255.254'
		]) {
			expect(addressSpaceFor(url), url).toBe('local');
		}
	});

	it('leaves public and unparseable targets unclassified', () => {
		for (const url of [
			'https://monitor.example.com',
			'https://tools.codokie.com/v1/fs/list',
			// Outside RFC1918 despite the leading 172.
			'http://172.32.0.1:8300',
			'not a url',
			''
		]) {
			expect(addressSpaceFor(url), url).toBeNull();
		}
	});
});

describe('isLoopbackUrl', () => {
	it('is true only for loopback, not the wider local network', () => {
		expect(isLoopbackUrl('http://127.0.0.1:8300')).toBe(true);
		expect(isLoopbackUrl('http://localhost:8300')).toBe(true);
		expect(isLoopbackUrl('http://192.168.1.10:8300')).toBe(false);
		expect(isLoopbackUrl('https://monitor.example.com')).toBe(false);
	});
});

describe('withLocalAddressSpace', () => {
	it('annotates loopback requests with `loopback` and preserves init', () => {
		const signal = new AbortController().signal;
		const out = withLocalAddressSpace('http://127.0.0.1:8300/v1/health', {
			method: 'GET',
			signal
		}) as RequestInit & { targetAddressSpace?: string };

		expect(out.targetAddressSpace).toBe('loopback');
		expect(out.method).toBe('GET');
		expect(out.signal).toBe(signal);
	});

	it('annotates local-network requests with `local`', () => {
		const out = withLocalAddressSpace('http://monitor.local:8300/v1/health') as RequestInit & {
			targetAddressSpace?: string;
		};
		expect(out.targetAddressSpace).toBe('local');
	});

	it('leaves public requests untouched', () => {
		const init = { method: 'POST' };
		const out = withLocalAddressSpace('https://monitor.example.com/v1/fs/list', init) as
			RequestInit & { targetAddressSpace?: string };

		expect(out.targetAddressSpace).toBeUndefined();
		expect(out).toBe(init);
	});

	it('defaults to an empty init', () => {
		const out = withLocalAddressSpace('http://localhost:8300') as RequestInit & {
			targetAddressSpace?: string;
		};
		expect(out.targetAddressSpace).toBe('loopback');
	});
});
