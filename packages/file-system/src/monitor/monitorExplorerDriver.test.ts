import { describe, expect, it, vi } from 'vitest';
import type { MonitorTransport } from './client.js';
import { createMonitorExplorerDriver } from './monitorExplorerDriver.js';

function transportStub(partial: Partial<MonitorTransport>): MonitorTransport {
	return {
		baseUrl: 'http://127.0.0.1:8300',
		list: vi.fn(),
		stat: vi.fn(),
		meta: vi.fn(async () => ({})),
		download: vi.fn(),
		readUrl: (path: string) => `http://127.0.0.1:8300/v1/fs/read?path=${encodeURIComponent(path)}`,
		zipUrl: (path: string, filename: string) =>
			`http://127.0.0.1:8300/v1/fs/zip?path=${encodeURIComponent(path)}&download=${encodeURIComponent(filename)}`,
		write: vi.fn(),
		copy: vi.fn(),
		pull: vi.fn(),
		push: vi.fn(),
		webrtcCreateJob: vi.fn(),
		webrtcCreateOffer: vi.fn(),
		webrtcGetOffer: vi.fn(),
		webrtcPostOffer: vi.fn(),
		webrtcPostAnswer: vi.fn(),
		webrtcProgress: vi.fn(),
		webrtcAbort: vi.fn(),
		unlink: vi.fn(),
		health: vi.fn(),
		watchAddRoot: vi.fn(),
		watchListRoots: vi.fn(),
		watchRemoveRoot: vi.fn(),
		watchUpdateSubs: vi.fn(),
		hostSnapshot: vi.fn(),
		gitSnapshot: vi.fn(),
		openHostEvents: vi.fn(),
		openGitEvents: vi.fn(),
		...partial
	} as MonitorTransport;
}

const profile = {
	v: 1 as const,
	id: 'p1',
	name: 't',
	baseUrl: 'http://127.0.0.1:8300',
	rootPath: '/tmp',
	createdAt: 1,
	updatedAt: 1
};

function listingAPng() {
	return vi.fn(async () => ({
		path: '/tmp',
		truncated: false,
		entries: [{ name: 'a.png', path: '/tmp/a.png', kind: 'file' as const, size: 12 }]
	}));
}

describe('monitor explorer driver capabilities', () => {
	it('keeps rename/move off when meta capabilities are missing', async () => {
		const transport = transportStub({
			meta: vi.fn(async () => ({ name: 'monitor', features: ['fs'] })),
			rename: vi.fn(async () => {})
		});
		const driver = await createMonitorExplorerDriver({
			profile,
			transport,
			enableWatch: false
		});
		expect(driver.capabilities.supportsRename).toBe(false);
		expect(driver.capabilities.supportsMove).toBe(false);
		expect(driver.rename).toBeUndefined();
		expect(driver.move).toBeUndefined();
	});

	it('enables rename/move from caps.fs.rename and calls transport.rename', async () => {
		const rename = vi.fn(async () => {});
		const transport = transportStub({
			meta: vi.fn(async () => ({
				capabilities: { fs: { ino: true, rename: true }, git: { blob: true } }
			})),
			list: vi.fn(async (path: string) => {
				if (path === '/tmp') {
					return {
						path,
						truncated: false,
						entries: [{ name: 'a.png', path: '/tmp/a.png', kind: 'file' as const }]
					};
				}
				return { path, truncated: false, entries: [] };
			}),
			rename
		});
		const driver = await createMonitorExplorerDriver({
			profile,
			transport,
			enableWatch: false
		});
		expect(driver.capabilities.supportsRename).toBe(true);
		expect(driver.capabilities.supportsMove).toBe(true);
		await driver.rename!('a.png', 'b.png');
		expect(rename).toHaveBeenCalledWith('/tmp/a.png', '/tmp/b.png');
		await driver.move!('a.png', 'dir/');
		expect(rename).toHaveBeenCalledWith('/tmp/a.png', '/tmp/dir/a.png');
	});

	it('rename a.png → a.png is a no-op (does not suffix, does not POST)', async () => {
		const rename = vi.fn(async () => {});
		const transport = transportStub({
			meta: vi.fn(async () => ({
				capabilities: { fs: { ino: true, rename: true } }
			})),
			list: listingAPng(),
			rename
		});
		const driver = await createMonitorExplorerDriver({
			profile,
			transport,
			enableWatch: false
		});
		const out = await driver.rename!('a.png', 'a.png');
		expect(out.id).toBe('a.png');
		expect(out.name).toBe('a.png');
		expect(rename).not.toHaveBeenCalled();
	});

	it('thumbUrl is omitted when the daemon has no fs.thumb capability', async () => {
		const driver = await createMonitorExplorerDriver({
			profile,
			transport: transportStub({ list: listingAPng() }),
			enableWatch: false
		});
		expect(driver.thumbUrl).toBeUndefined();
	});

	it('thumbUrl is a header-free GET to /v1/fs/thumb when advertised', async () => {
		const driver = await createMonitorExplorerDriver({
			profile,
			transport: transportStub({
				list: listingAPng(),
				meta: vi.fn(async () => ({
					capabilities: { fs: { ino: true, rename: true, thumb: true }, git: { blob: true } }
				})),
				thumbUrl: (path: string, size?: number) =>
					`http://127.0.0.1:8300/v1/fs/thumb?path=${encodeURIComponent(path)}&size=${size ?? 96}`
			}),
			enableWatch: false
		});
		const loc = await driver.thumbUrl!('a.png', { maxDim: 32 });
		expect(loc?.url).toContain('/v1/fs/thumb?path=');
		expect(loc?.url).toContain('size=32');
		expect(loc?.url).toContain(encodeURIComponent('/tmp/a.png'));
	});

	it('downloadUrl is a header-free GET Chrome can open', async () => {
		const driver = await createMonitorExplorerDriver({
			profile,
			transport: transportStub({ list: listingAPng() }),
			enableWatch: false
		});
		const loc = await driver.downloadUrl!('a.png');
		expect(loc?.filename).toBe('a.png');
		expect(loc?.url).toContain('/v1/fs/read?path=');
		expect(loc?.url).toContain(encodeURIComponent('/tmp/a.png'));
		expect(new URL(loc!.url).searchParams.get('download')).toBe('a.png');
	});

	it('downloadUrl for a folder is GET /v1/fs/zip (zip on drop)', async () => {
		const driver = await createMonitorExplorerDriver({
			profile,
			transport: transportStub({ list: listingAPng() }),
			enableWatch: false
		});
		const loc = await driver.downloadUrl!('Docs/');
		expect(loc?.filename).toBe('Docs.zip');
		expect(loc?.url).toContain('/v1/fs/zip?path=');
		expect(new URL(loc!.url).searchParams.get('download')).toBe('Docs.zip');
	});

	it('move a.png into the same parent does not suffix', async () => {
		const rename = vi.fn(async () => {});
		const transport = transportStub({
			meta: vi.fn(async () => ({
				capabilities: { fs: { ino: true, rename: true } }
			})),
			list: listingAPng(),
			rename
		});
		const driver = await createMonitorExplorerDriver({
			profile,
			transport,
			enableWatch: false
		});
		await driver.move!('a.png', null);
		expect(rename).not.toHaveBeenCalled();
	});

	it('rejects nested rename names', async () => {
		const rename = vi.fn(async () => {});
		const transport = transportStub({
			meta: vi.fn(async () => ({
				capabilities: { fs: { ino: true, rename: true } }
			})),
			list: listingAPng(),
			rename
		});
		const driver = await createMonitorExplorerDriver({
			profile,
			transport,
			enableWatch: false
		});
		await expect(driver.rename!('a.png', 'foo/bar.png')).rejects.toMatchObject({
			code: 'INVALID_NAME'
		});
		expect(rename).not.toHaveBeenCalled();
	});

	it('plumbs ino/dev onto ExplorerEntry.meta', async () => {
		const transport = transportStub({
			meta: vi.fn(async () => ({
				capabilities: { fs: { ino: true, rename: false } }
			})),
			list: vi.fn(async () => ({
				path: '/tmp',
				truncated: false,
				entries: [
					{
						name: 'a.png',
						path: '/tmp/a.png',
						kind: 'file',
						size: 12,
						mtime_ms: 1700000000000,
						ino: '12345',
						dev: '1'
					}
				]
			}))
		});
		const driver = await createMonitorExplorerDriver({
			profile,
			transport,
			enableWatch: false
		});
		const { entries } = await driver.list({ parentId: null });
		expect(entries[0]?.meta).toEqual({ ino: '12345', dev: '1' });
	});

	it('copy stays dest-root-relative', async () => {
		const copy = vi.fn(async () => {});
		const transport = transportStub({
			list: listingAPng(),
			copy
		});
		const driver = await createMonitorExplorerDriver({
			profile,
			transport,
			enableWatch: false
		});
		await driver.copy!('a.png', null);
		expect(copy).toHaveBeenCalledWith('/tmp/a.png', '/tmp/a (1).png', expect.anything());
	});

	it('copyFromAbsolute uniqueNames dest and copies from the source abs path', async () => {
		const copy = vi.fn(async () => {});
		const transport = transportStub({
			list: listingAPng(),
			copy
		});
		const driver = await createMonitorExplorerDriver({
			profile,
			transport,
			enableWatch: false
		});
		expect(driver.absolutePath!('shot.png')).toBe('/tmp/shot.png');
		await driver.copyFromAbsolute!('/home/other/shot.png', null, 'shot.png');
		expect(copy).toHaveBeenCalledWith('/home/other/shot.png', '/tmp/shot.png', expect.anything());
		await driver.copyFromAbsolute!('/home/other/a.png', null, 'a.png');
		expect(copy).toHaveBeenCalledWith('/home/other/a.png', '/tmp/a (1).png', expect.anything());
	});

	it('pullFromUrl uniqueNames dest and calls transport.pull', async () => {
		const pull = vi.fn(async () => {});
		const transport = transportStub({
			list: listingAPng(),
			pull
		});
		const driver = await createMonitorExplorerDriver({
			profile,
			transport,
			enableWatch: false
		});
		await driver.pullFromUrl!('https://f000.example/file', null, 'shot.png');
		expect(pull).toHaveBeenCalledWith(
			'https://f000.example/file',
			'/tmp/shot.png',
			expect.anything()
		);
		await driver.pullFromUrl!('https://f000.example/a.png', null, 'a.png');
		expect(pull).toHaveBeenCalledWith(
			'https://f000.example/a.png',
			'/tmp/a (1).png',
			expect.anything()
		);
	});

	it('pushToUpload calls transport.push with abs from and mint fields', async () => {
		const push = vi.fn(async () => {});
		const transport = transportStub({
			list: listingAPng(),
			push
		});
		const driver = await createMonitorExplorerDriver({
			profile,
			transport,
			enableWatch: false
		});
		await driver.pushToUpload!(
			'a.png',
			{
				uploadUrl: 'https://pod.example/u',
				authorizationToken: 'tok',
				destFileName: 'a.png',
				contentType: 'text/plain'
			}
		);
		expect(push).toHaveBeenCalledTimes(1);
		const [body] = push.mock.calls[0] as unknown as [Record<string, unknown>];
		expect(body).toEqual({
			from: '/tmp/a.png',
			uploadUrl: 'https://pod.example/u',
			token: 'tok',
			fileName: 'a.png',
			contentType: 'text/plain'
		});
		expect(body).not.toHaveProperty('applicationKey');
		expect(body).not.toHaveProperty('applicationKeyId');
		expect(JSON.stringify(body)).not.toMatch(/applicationKey/);
	});

	it('writeExactName skips uniqueName', async () => {
		const write = vi.fn(async () => ({ name: 'a.png', path: '/tmp/a.png', kind: 'file' as const }));
		const transport = transportStub({
			list: listingAPng(),
			write
		});
		const driver = await createMonitorExplorerDriver({
			profile,
			transport,
			enableWatch: false
		});
		await driver.upload!(null, new File(['x'], 'a.png'));
		expect(write).toHaveBeenCalledWith('/tmp/a (1).png', expect.any(File), expect.anything());
		write.mockClear();
		await driver.writeExactName!(null, new File(['y'], 'a.png'), 'a.png');
		expect(write).toHaveBeenCalledWith('/tmp/a.png', expect.any(File), expect.anything());
	});
});
