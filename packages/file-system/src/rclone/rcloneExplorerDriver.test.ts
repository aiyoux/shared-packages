/**
 * RcloneExplorerDriver tests against RcloneSimulator.
 * No network. Run: npm run test:rclone
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
	EXPLORER_DOWNLOAD_MAX_BYTES,
	type ExplorerDriver
} from '../ui/explorerDriver.js';
import { createRcloneExplorerDriver } from './rcloneExplorerDriver.js';
import { ExplorerRcloneError } from './errors.js';
import { RcloneSimulator } from './rcloneSimulator.js';
import type { RcloneConnectionProfileV1 } from './types.js';

const PROFILE = (rootPath?: string): RcloneConnectionProfileV1 => ({
	v: 1,
	id: 'test-profile',
	name: 'test',
	baseUrl: 'http://127.0.0.1:7750',
	fs: 'sim:',
	rootPath,
	rcUser: 'u',
	rcPass: 'p',
	createdAt: Date.now(),
	updatedAt: Date.now()
});

async function bootDriver(opts?: {
	rootPath?: string;
}): Promise<{ driver: ExplorerDriver; sim: RcloneSimulator }> {
	const sim = new RcloneSimulator();
	const driver = await createRcloneExplorerDriver({
		profile: PROFILE(opts?.rootPath),
		transport: sim.transport()
	});
	return { driver, sim };
}

describe('RcloneExplorerDriver (RcloneSimulator)', () => {
	it('capabilities: no trash/soft-delete; has upload/download; id=rclone; no sibling order', async () => {
		const { driver } = await bootDriver();
		expect(driver.id).toBe('rclone');
		expect(driver.capabilities.supportsTrash).toBe(false);
		expect(driver.capabilities.supportsSoftDelete).toBe(false);
		expect(driver.capabilities.supportsUpload).toBe(true);
		expect(driver.capabilities.supportsDownload).toBe(true);
		expect(driver.capabilities.supportsSiblingOrder).toBe(false);
		expect(driver.reorder).toBeUndefined();
		expect(driver.restore).toBeUndefined();
		expect(driver.emptyTrash).toBeUndefined();
	});

	it('ready succeeds; 401 → RCLONE_AUTH', async () => {
		const { driver, sim } = await bootDriver();
		await driver.ready();
		sim.authorized = false;
		await expect(driver.ready()).rejects.toMatchObject({ code: 'RCLONE_AUTH' });
	});

	it('lists files and folders; mkdir enter empty; delete empty folder', async () => {
		const { driver } = await bootDriver();
		await driver.upload!(null, new File([new Uint8Array([1, 2, 3])], 'a.skch'));
		const folder = await driver.mkdir!(null, 'photos');
		const { entries, truncated } = await driver.list({ parentId: null });
		expect(truncated).toBe(false);
		expect(entries.some((e) => e.kind === 'folder' && e.name === 'photos')).toBe(true);
		expect(entries.some((e) => e.kind === 'file' && e.name === 'a.skch')).toBe(true);

		const inside = await driver.list({ parentId: folder.id });
		expect(inside.entries).toHaveLength(0);
		await driver.delete(folder.id);
		const root = await driver.list({ parentId: null });
		expect(root.entries.some((e) => e.id === folder.id)).toBe(false);
	});

	it('delete file keeps prefix siblings', async () => {
		const { driver, sim } = await bootDriver();
		sim.seedFile('report', 'v1');
		sim.seedFile('report-final.pdf', 'keep');
		await driver.delete('report');
		const after = await driver.list({ parentId: null });
		expect(after.entries.map((e) => e.name)).toEqual(['report-final.pdf']);
	});

	it('delete non-empty folder uses purge', async () => {
		const { driver } = await bootDriver();
		const folder = await driver.mkdir!(null, 'docs');
		await driver.upload!(
			folder.id,
			new File([new Uint8Array([9])], 'note.txt', { type: 'text/plain' })
		);
		await driver.delete(folder.id);
		const root = await driver.list({ parentId: null });
		expect(root.entries.some((e) => e.name === 'docs')).toBe(false);
	});

	it('rejects folder rename/move/copy', async () => {
		const { driver } = await bootDriver();
		const folder = await driver.mkdir!(null, 'f1');
		await expect(driver.rename!(folder.id, 'f2')).rejects.toMatchObject({
			code: 'RCLONE_FOLDER_OP_UNSUPPORTED'
		});
		await expect(driver.move!(folder.id, null)).rejects.toMatchObject({
			code: 'RCLONE_FOLDER_OP_UNSUPPORTED'
		});
		await expect(driver.copy!(folder.id, null)).rejects.toMatchObject({
			code: 'RCLONE_FOLDER_OP_UNSUPPORTED'
		});
	});

	it('file rename, move, copy work', async () => {
		const { driver } = await bootDriver();
		await driver.upload!(null, new File([new Uint8Array([1])], 'old.txt'));
		const renamed = await driver.rename!('old.txt', 'new.txt');
		expect(renamed.name).toBe('new.txt');
		let listed = await driver.list({ parentId: null });
		expect(listed.entries.some((e) => e.name === 'old.txt')).toBe(false);
		expect(listed.entries.some((e) => e.name === 'new.txt')).toBe(true);

		const dest = await driver.mkdir!(null, 'box');
		await driver.move!('new.txt', dest.id);
		listed = await driver.list({ parentId: dest.id });
		expect(listed.entries.some((e) => e.name === 'new.txt')).toBe(true);

		await driver.copy!('box/new.txt', null);
		const root = await driver.list({ parentId: null });
		expect(root.entries.some((e) => e.kind === 'file' && e.name === 'new.txt')).toBe(true);
	});

	it('download works; RCLONE_TOO_LARGE code exists at design cap', async () => {
		const { driver } = await bootDriver();
		await driver.upload!(null, new File([new Uint8Array([1, 2, 3, 4])], 'tiny.bin'));
		const blob = await driver.download!('tiny.bin');
		expect(blob.size).toBe(4);
		expect(EXPLORER_DOWNLOAD_MAX_BYTES).toBe(100 * 1024 * 1024);
		expect(new ExplorerRcloneError('RCLONE_TOO_LARGE', 'cap').code).toBe('RCLONE_TOO_LARGE');
	});

	it('getPath under rootPath', async () => {
		const { driver, sim } = await bootDriver({ rootPath: 'team' });
		// seed under remote team/
		sim.seedDir('team/docs/');
		sim.seedDir('team/docs/2026/');
		const path = await driver.getPath('docs/2026/');
		expect(path.map((p) => p.name)).toEqual(['docs', '2026']);
		expect(path[0]?.parentId).toBeNull();
	});

	it('upload abort maps to RCLONE_ABORTED', async () => {
		const { driver } = await bootDriver();
		const ac = new AbortController();
		ac.abort();
		await expect(
			driver.upload!(null, new File([new Uint8Array([1])], 'x.bin'), { signal: ac.signal })
		).rejects.toMatchObject({ code: 'RCLONE_ABORTED' });
	});
});
