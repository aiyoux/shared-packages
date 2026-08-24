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
		write: vi.fn(),
		copy: vi.fn(),
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

describe('monitor explorer driver capabilities', () => {
	it('keeps rename/move off when meta capabilities are missing', async () => {
		const transport = transportStub({
			meta: vi.fn(async () => ({ name: 'monitor', features: ['fs'] }))
		});
		const driver = await createMonitorExplorerDriver({
			profile,
			transport,
			enableWatch: false
		});
		expect(driver.capabilities.supportsRename).toBe(false);
		expect(driver.capabilities.supportsMove).toBe(false);
	});

	it('enables rename/move from caps.fs.rename and calls transport.rename', async () => {
		const rename = vi.fn(async () => {});
		const transport = transportStub({
			meta: vi.fn(async () => ({
				capabilities: { fs: { ino: true, rename: true }, git: { blob: true } }
			})),
			list: vi.fn(async () => ({ path: '/tmp', entries: [], truncated: false })),
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
});
