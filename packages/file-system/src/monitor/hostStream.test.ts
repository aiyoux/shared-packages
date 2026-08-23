import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMonitorClient } from './client.js';
import { abortAllHostStreams, getHostStream } from './hostStream.js';
import type { MonitorConnectionProfileV1 } from './types.js';

const profile: MonitorConnectionProfileV1 = {
	v: 1,
	id: 'p-host',
	name: 'local',
	baseUrl: 'http://127.0.0.1:8300',
	rootPath: '/tmp',
	createdAt: 1,
	updatedAt: 1
};

const hostBody = { cpu_pct: 9, mem_used: 2, mem_total: 8, disks: [] };

function sseFetch() {
	const encoder = new TextEncoder();
	let streams = 0;
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes('/v1/host/snapshot')) {
			return new Response(JSON.stringify(hostBody), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}
		if (url.includes('/v1/host/events')) {
			streams += 1;
			const stream = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(
						encoder.encode(`event: host.snapshot\ndata: ${JSON.stringify({ ...hostBody, cpu_pct: 11 })}\n\n`)
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
	abortAllHostStreams();
});

describe('getHostStream', () => {
	it('multiplexes listeners onto one host SSE per profile', async () => {
		const { fetchMock, streamsOpened } = sseFetch();
		const transport = createMonitorClient({
			baseUrl: profile.baseUrl,
			fetchImpl: fetchMock as unknown as typeof fetch
		});
		const a: number[] = [];
		const b: number[] = [];
		const s1 = getHostStream(profile, { transport });
		const s2 = getHostStream(profile, { transport });
		expect(s1).toBe(s2);
		const off1 = s1.subscribe((snap) => a.push(snap.cpu_pct));
		const off2 = s2.subscribe((snap) => b.push(snap.cpu_pct));
		await vi.waitFor(() => expect(a.length).toBeGreaterThan(0));
		await vi.waitFor(() => expect(b.length).toBeGreaterThan(0));
		expect(streamsOpened()).toBe(1);
		off1();
		off2();
	});
});
