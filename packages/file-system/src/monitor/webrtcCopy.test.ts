import { describe, expect, it, vi } from 'vitest';
import type { ExplorerEntry } from '../ui/explorerDriver.js';
import type { MonitorTransport } from './client.js';
import { ferryWebrtcCopy, type WebrtcCopyPeer } from './webrtcCopy.js';

function clientStub(partial: Partial<MonitorTransport>): MonitorTransport {
	return {
		baseUrl: 'http://127.0.0.1:8300',
		webrtcCreateJob: vi.fn(async () => ({ jobId: 'j', token: 't' })),
		webrtcCreateOffer: vi.fn(async () => ({ sdp: 'offer' })),
		webrtcGetOffer: vi.fn(async () => ({ sdp: 'offer' })),
		webrtcPostOffer: vi.fn(async () => ({ sdp: 'answer' })),
		webrtcPostAnswer: vi.fn(async () => ({ sdp: 'answer' })),
		webrtcProgress: vi.fn(async (_jobId, _token, opts?: { onEvent?: (ev: { transferred: number; done?: boolean }) => void }) => {
			opts?.onEvent?.({ transferred: 4, done: true });
		}),
		webrtcAbort: vi.fn(async () => {}),
		unlink: vi.fn(async () => {}),
		...partial
	} as unknown as MonitorTransport;
}

function peer(opts: {
	root: string;
	client: MonitorTransport;
	used?: Set<string>;
	download?: WebrtcCopyPeer['download'];
}): WebrtcCopyPeer {
	const used = opts.used ?? new Set<string>();
	const written: string[] = [];
	const p: WebrtcCopyPeer & { written: string[] } = {
		written,
		monitorClient: opts.client,
		absolutePath: (id: string) => `${opts.root}/${id}`,
		async uniqueName(_parent, base) {
			if (!used.has(base)) {
				used.add(base);
				return base;
			}
			const next = `${base.replace(/(\.[^.]+)?$/, '')} (1)${base.includes('.') ? base.slice(base.lastIndexOf('.')) : ''}`;
			used.add(next);
			return next;
		},
		async writeExactName(_parent, file, exactName) {
			written.push(exactName);
			return { id: exactName, parentId: null, name: exactName, kind: 'file' as const };
		},
		download: opts.download
	};
	return p;
}

const entry: ExplorerEntry = {
	id: 'note.txt',
	parentId: null,
	name: 'note.txt',
	kind: 'file',
	size: 4
};

describe('ferryWebrtcCopy', () => {
	it('exchanges offer/answer and reports progress without uniqueName twice', async () => {
		const srcClient = clientStub({
			webrtcCreateJob: vi.fn(async () => ({ jobId: 'src', token: 'st' }))
		});
		const dstClient = clientStub({
			webrtcCreateJob: vi.fn(async () => ({ jobId: 'dst', token: 'dt' })),
			webrtcProgress: vi.fn(async (_jobId, _token, opts) => {
				opts?.onEvent?.({ transferred: 4, size: 4, ice: 'connected', icePath: 'host', done: true });
			})
		});
		const source = peer({ root: '/home/a', client: srcClient });
		const dest = peer({ root: '/home/b', client: dstClient });
		const ticks: Array<{ ice?: string; icePath?: string }> = [];
		await ferryWebrtcCopy({
			source,
			dest,
			entry,
			destParentId: null,
			onProgress: (ev) => ticks.push({ ice: ev.ice, icePath: ev.icePath })
		});
		expect(srcClient.webrtcCreateJob).toHaveBeenCalledWith({
			role: 'offerer',
			from: '/home/a/note.txt',
			size: 4
		});
		expect(dstClient.webrtcCreateJob).toHaveBeenCalledWith({
			role: 'answerer',
			to: '/home/b/note.txt',
			size: 4
		});
		expect(srcClient.webrtcCreateOffer).toHaveBeenCalledWith('src', 'st', expect.anything());
		expect(srcClient.webrtcGetOffer).not.toHaveBeenCalled();
		expect(dstClient.webrtcPostAnswer).toHaveBeenCalledWith('dst', 'dt', 'offer', expect.anything());
		expect(srcClient.webrtcPostAnswer).toHaveBeenCalledWith('src', 'st', 'answer', expect.anything());
		expect(ticks.some((t) => t.icePath === 'host')).toBe(true);
		expect(srcClient.webrtcAbort).not.toHaveBeenCalled();
	});

	it('POST-create 409 then GET-polls offer', async () => {
		const srcClient = clientStub({
			webrtcCreateJob: vi.fn(async () => ({ jobId: 'src', token: 'st' })),
			webrtcCreateOffer: vi.fn(async () => {
				throw new Error('Webrtc offer failed (409)');
			}),
			webrtcGetOffer: vi.fn(async () => ({ sdp: 'offer' }))
		});
		const dstClient = clientStub({
			webrtcCreateJob: vi.fn(async () => ({ jobId: 'dst', token: 'dt' })),
			webrtcProgress: vi.fn(async (_jobId, _token, opts) => {
				opts?.onEvent?.({ transferred: 4, size: 4, ice: 'connected', icePath: 'stun', done: true });
			})
		});
		const source = peer({ root: '/home/a', client: srcClient });
		const dest = peer({ root: '/home/b', client: dstClient });
		await ferryWebrtcCopy({
			source,
			dest,
			entry,
			destParentId: null
		});
		expect(srcClient.webrtcCreateOffer).toHaveBeenCalled();
		expect(srcClient.webrtcGetOffer).toHaveBeenCalledWith('src', 'st', expect.anything());
		expect(dstClient.webrtcPostAnswer).toHaveBeenCalledWith('dst', 'dt', 'offer', expect.anything());
	});

	it('ICE fail aborts both, then writeExactName after confirm', async () => {
		const srcClient = clientStub({
			webrtcCreateJob: vi.fn(async () => ({ jobId: 'src', token: 'st' }))
		});
		const dstClient = clientStub({
			webrtcCreateJob: vi.fn(async () => ({ jobId: 'dst', token: 'dt' })),
			webrtcProgress: vi.fn(async (_jobId, _token, opts) => {
				opts?.onEvent?.({ transferred: 0, ice: 'failed', error: 'ICE failed' });
			})
		});
		const source = peer({
			root: '/home/a',
			client: srcClient,
			download: async () => new Blob(['abcd'])
		});
		const dest = peer({ root: '/home/b', client: dstClient });
		const confirm = vi.fn(async () => true);
		await ferryWebrtcCopy({
			source,
			dest,
			entry,
			destParentId: null,
			confirmDualPhase: confirm
		});
		expect(srcClient.webrtcAbort).toHaveBeenCalledWith('src', 'st');
		expect(dstClient.webrtcAbort).toHaveBeenCalledWith('dst', 'dt');
		expect(dstClient.unlink).toHaveBeenCalledWith('/home/b/note.txt');
		expect(confirm).toHaveBeenCalledOnce();
		expect((dest as WebrtcCopyPeer & { written: string[] }).written).toEqual(['note.txt']);
	});

	it('does not write file (1) when abort cannot run', async () => {
		const srcClient = clientStub({
			webrtcCreateJob: vi.fn(async () => ({ jobId: 'src', token: 'st' })),
			webrtcAbort: vi.fn(async () => {
				throw new Error('Cannot reach monitor');
			})
		});
		const dstClient = clientStub({
			webrtcCreateJob: vi.fn(async () => ({ jobId: 'dst', token: 'dt' })),
			webrtcProgress: vi.fn(async () => {
				throw new Error('Webrtc progress failed (500)');
			}),
			webrtcAbort: vi.fn(async () => {
				throw new Error('Cannot reach monitor');
			})
		});
		const source = peer({
			root: '/home/a',
			client: srcClient,
			download: async () => new Blob(['abcd'])
		});
		const dest = peer({ root: '/home/b', client: dstClient });
		const confirm = vi.fn(async () => true);
		await expect(
			ferryWebrtcCopy({
				source,
				dest,
				entry,
				destParentId: null,
				confirmDualPhase: confirm
			})
		).rejects.toThrow(/progress failed|Cannot reach/);
		expect(confirm).not.toHaveBeenCalled();
		expect((dest as WebrtcCopyPeer & { written: string[] }).written).toEqual([]);
	});
});
