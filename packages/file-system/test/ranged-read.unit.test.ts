import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchByteRange } from '../src/ui/rangedRead.ts';
import { linkBytesPerSecond, resetLinkSpeedForTest } from '../src/linkSpeed.ts';

const body = new Uint8Array(200_000).map((_, i) => i % 251);

function server(mode: 'ranged' | 'whole' | 'past-end'): { fetch: typeof fetch; ranges: string[] } {
	const ranges: string[] = [];
	const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		const range = new Headers(init?.headers).get('range') ?? '';
		ranges.push(range);
		if (mode === 'past-end') {
			return new Response(null, { status: 416, headers: { 'content-range': `bytes */${body.length}` } });
		}
		if (mode === 'whole') {
			return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
		}
		const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!;
		const start = Number(a);
		const end = Math.min(Number(b), body.length - 1);
		return new Response(body.slice(start, end + 1), {
			status: 206,
			headers: { 'content-range': `bytes ${start}-${end}/${body.length}` }
		});
	}) as typeof fetch;
	return { fetch: fetchImpl, ranges };
}

describe('fetchByteRange', () => {
	afterEach(() => resetLinkSpeedForTest());

	it('asks for one range and returns exactly those bytes and the file length', async () => {
		const s = server('ranged');
		const got = await fetchByteRange('http://127.0.0.1:8300/v1/fs/read?path=x', 100, 65_635, { fetchImpl: s.fetch });
		assert.deepEqual(s.ranges, ['bytes=100-65635']);
		assert.equal(got.total, body.length);
		assert.deepEqual(got.bytes, body.slice(100, 65_636));
		assert.ok(linkBytesPerSecond('http://127.0.0.1:8300') !== undefined, 'a 64 KiB read measures the link');
	});

	it('takes only the asked window from a server that ignores Range', async () => {
		const s = server('whole');
		const got = await fetchByteRange('http://h/v1/fs/read?path=x', 1000, 1999, { fetchImpl: s.fetch });
		assert.equal(got.bytes.byteLength, 1000);
		assert.deepEqual(got.bytes, body.slice(1000, 2000));
		assert.equal(got.total, body.length);
	});

	it('returns nothing past the end of the file', async () => {
		const s = server('past-end');
		const got = await fetchByteRange('http://h/v1/fs/read?path=x', 500_000, 500_100, { fetchImpl: s.fetch });
		assert.equal(got.bytes.byteLength, 0);
		assert.equal(got.total, body.length);
	});
});
