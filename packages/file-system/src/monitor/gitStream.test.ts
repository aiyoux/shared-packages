import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMonitorClient } from './client.js';
import { abortAllGitStreams, getGitStream } from './gitStream.js';
import type { MonitorConnectionProfileV1 } from './types.js';

const profile: MonitorConnectionProfileV1 = {
	v: 1,
	id: 'p-git',
	name: 'local',
	baseUrl: 'http://127.0.0.1:8300',
	rootPath: '/tmp',
	createdAt: 1,
	updatedAt: 1
};

function sseFetch() {
	const encoder = new TextEncoder();
	let streams = 0;
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes('/v1/git/snapshot')) {
			return new Response(JSON.stringify({ branch: 'main', dirty: false, log: [] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}
		if (url.includes('/v1/git/events')) {
			streams += 1;
			const stream = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(
						encoder.encode(
							`event: git.snapshot\ndata: ${JSON.stringify({ branch: 'main', dirty: true, log: [] })}\n\n`
						)
					);
				}
			});
			return new Response(stream, {
				status: 200,
				headers: { 'content-type': 'text/event-stream' }
			});
		}
		return new Response('no', { status: 404 });
	});
	return { fetchMock, streamsOpened: () => streams };
}

afterEach(() => {
	abortAllGitStreams();
});

describe('getGitStream', () => {
	it('multiplexes listeners onto one git SSE per profile+path', async () => {
		const { fetchMock, streamsOpened } = sseFetch();
		const transport = createMonitorClient({
			baseUrl: profile.baseUrl,
			fetchImpl: fetchMock as unknown as typeof fetch
		});
		const a: boolean[] = [];
		const b: boolean[] = [];
		const s1 = getGitStream(profile, '/tmp/repo', { transport });
		const s2 = getGitStream(profile, '/tmp/repo', { transport });
		expect(s1).toBe(s2);
		const off1 = s1.subscribe((snap) => a.push(snap.dirty));
		const off2 = s2.subscribe((snap) => b.push(snap.dirty));
		await vi.waitFor(() => expect(a.length).toBeGreaterThan(0));
		await vi.waitFor(() => expect(b.length).toBeGreaterThan(0));
		expect(streamsOpened()).toBe(1);
		off1();
		off2();
	});
});
