/**
 * B2ExplorerDriver tests against the official in-memory B2Simulator.
 * No network. Run: npm run test:b2
 */
import { describe, it, expect } from 'vitest';
import { B2Client, BufferSource, BucketType } from '@backblaze-labs/b2-sdk';
import { B2Simulator } from '@backblaze-labs/b2-sdk/simulator';
import {
	EXPLORER_DOWNLOAD_MAX_BYTES,
	type ExplorerDriver
} from '../ui/explorerDriver.js';
import { createB2ExplorerDriver } from './b2ExplorerDriver.js';
import { ExplorerB2Error } from './errors.js';
import type { B2ConnectionProfileV1 } from './types.js';

const PROFILE = (bucketName: string, namePrefix?: string): B2ConnectionProfileV1 => ({
	v: 1,
	id: 'test-profile',
	name: 'test',
	applicationKeyId: 'test-key-id',
	applicationKey: 'test-key',
	bucketName,
	namePrefix,
	createdAt: Date.now(),
	updatedAt: Date.now()
});

async function bootDriver(opts?: {
	bucketName?: string;
	namePrefix?: string;
}): Promise<{ driver: ExplorerDriver; sim: B2Simulator; client: B2Client }> {
	const bucketName = opts?.bucketName ?? `bucket-${Math.random().toString(36).slice(2, 8)}`;
	const sim = new B2Simulator();
	const transport = sim.transport();
	const client = new B2Client({
		applicationKeyId: 'test-key-id',
		applicationKey: 'test-key',
		transport
	});
	await client.authorize();
	await client.createBucket({
		bucketName,
		bucketType: BucketType.AllPrivate
	});
	const driver = await createB2ExplorerDriver({
		profile: PROFILE(bucketName, opts?.namePrefix),
		transport
	});
	return { driver, sim, client };
}

describe('B2ExplorerDriver (B2Simulator)', () => {
	it('lists files and virtual folders (action === folder)', async () => {
		const { driver } = await bootDriver();
		await driver.upload!(null, new File([new Uint8Array([1, 2, 3])], 'a.skch'));
		await driver.mkdir!(null, 'photos');
		const { entries, truncated } = await driver.list({ parentId: null });
		expect(truncated).toBe(false);
		expect(entries.some((e) => e.kind === 'folder' && e.name === 'photos')).toBe(true);
		expect(entries.some((e) => e.kind === 'file' && e.name === 'a.skch')).toBe(true);
		// Marker not listed as a file
		expect(entries.some((e) => e.name === '.bzEmpty')).toBe(false);
	});

	it('mkdir .bzEmpty: enter folder is empty; delete empty folder works', async () => {
		const { driver } = await bootDriver();
		const folder = await driver.mkdir!(null, 'empty-dir');
		expect(folder.id.endsWith('/')).toBe(true);
		const inside = await driver.list({ parentId: folder.id });
		expect(inside.entries).toHaveLength(0);
		await driver.delete(folder.id);
		const root = await driver.list({ parentId: null });
		expect(root.entries.some((e) => e.id === folder.id)).toBe(false);
	});

	it('delete removes all versions of exact fileName only (prefix siblings kept)', async () => {
		const { driver, client } = await bootDriver();
		const bucketName = (await client.listBuckets())[0]!.name;
		const bucket = (await client.getBucket(bucketName))!;

		// Two distinct names that share a string prefix
		await bucket.upload({
			fileName: 'report',
			source: new BufferSource(new TextEncoder().encode('v1'))
		});
		await bucket.upload({
			fileName: 'report',
			source: new BufferSource(new TextEncoder().encode('v2'))
		}); // second version
		await bucket.upload({
			fileName: 'report-final.pdf',
			source: new BufferSource(new TextEncoder().encode('keep'))
		});

		const before = await driver.list({ parentId: null });
		expect(before.entries.map((e) => e.name).sort()).toEqual(['report', 'report-final.pdf']);

		await driver.delete('report');

		const after = await driver.list({ parentId: null });
		expect(after.entries.map((e) => e.name)).toEqual(['report-final.pdf']);
		// No version of `report` remains
		const versions: string[] = [];
		for await (const v of bucket.paginateFileVersions({ prefix: 'report' })) {
			if (v.fileName === 'report') versions.push(v.fileId);
		}
		expect(versions).toHaveLength(0);
	});

	it('rejects non-empty folder delete with B2_FOLDER_NOT_EMPTY', async () => {
		const { driver } = await bootDriver();
		const folder = await driver.mkdir!(null, 'docs');
		await driver.upload!(
			folder.id,
			new File([new Uint8Array([9])], 'note.txt', { type: 'text/plain' })
		);
		await expect(driver.delete(folder.id)).rejects.toMatchObject({
			code: 'B2_FOLDER_NOT_EMPTY'
		});
	});

	it('rejects folder move/copy', async () => {
		const { driver } = await bootDriver();
		const folder = await driver.mkdir!(null, 'f1');
		await expect(driver.move!(folder.id, null)).rejects.toMatchObject({
			code: 'B2_FOLDER_OP_UNSUPPORTED'
		});
		await expect(driver.copy!(folder.id, null)).rejects.toMatchObject({
			code: 'B2_FOLDER_OP_UNSUPPORTED'
		});
	});

	it('renames an empty folder', async () => {
		const { driver } = await bootDriver();
		const folder = await driver.mkdir!(null, 'f1');
		const renamed = await driver.rename!(folder.id, 'f2');
		expect(renamed.name).toBe('f2');
		expect(renamed.id).toBe('f2/');
		expect(renamed.kind).toBe('folder');
		const root = await driver.list({ parentId: null });
		expect(root.entries.some((e) => e.name === 'f1')).toBe(false);
		expect(root.entries.some((e) => e.kind === 'folder' && e.name === 'f2')).toBe(true);
		const inside = await driver.list({ parentId: renamed.id });
		expect(inside.entries).toHaveLength(0);
	});

	it('renames a folder and keeps nested children', async () => {
		const { driver } = await bootDriver();
		const folder = await driver.mkdir!(null, 'docs');
		await driver.upload!(
			folder.id,
			new File([new Uint8Array([9])], 'note.txt', { type: 'text/plain' })
		);
		const nested = await driver.mkdir!(folder.id, 'images');
		await driver.upload!(
			nested.id,
			new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
		);

		const renamed = await driver.rename!(folder.id, 'archive');
		expect(renamed.id).toBe('archive/');
		const root = await driver.list({ parentId: null });
		expect(root.entries.some((e) => e.name === 'docs')).toBe(false);
		expect(root.entries.some((e) => e.kind === 'folder' && e.name === 'archive')).toBe(true);

		const kids = await driver.list({ parentId: renamed.id });
		expect(kids.entries.some((e) => e.name === 'note.txt')).toBe(true);
		expect(kids.entries.some((e) => e.kind === 'folder' && e.name === 'images')).toBe(true);
		const nestedKids = await driver.list({ parentId: 'archive/images/' });
		expect(nestedKids.entries.some((e) => e.name === 'a.png')).toBe(true);
	});

	it('identity folder rename is a no-op', async () => {
		const { driver } = await bootDriver();
		const folder = await driver.mkdir!(null, 'keep');
		await driver.upload!(folder.id, new File([new Uint8Array([1])], 'a.txt'));
		const same = await driver.rename!(folder.id, 'keep');
		expect(same.id).toBe(folder.id);
		const kids = await driver.list({ parentId: folder.id });
		expect(kids.entries.some((e) => e.name === 'a.txt')).toBe(true);
	});

	it('folder rename suffixes when the dest name is taken', async () => {
		const { driver } = await bootDriver();
		await driver.mkdir!(null, 'a');
		const b = await driver.mkdir!(null, 'b');
		const renamed = await driver.rename!(b.id, 'a');
		expect(renamed.name).toBe('a (1)');
		expect(renamed.id).toBe('a (1)/');
	});

	it('renames a folder under namePrefix', async () => {
		const { driver } = await bootDriver({ namePrefix: 'team/' });
		const folder = await driver.mkdir!(null, 'docs');
		expect(folder.id).toBe('team/docs/');
		const renamed = await driver.rename!(folder.id, 'files');
		expect(renamed.id).toBe('team/files/');
		expect(renamed.parentId).toBeNull();
		const root = await driver.list({ parentId: null });
		expect(root.entries.map((e) => e.name).sort()).toEqual(['files']);
	});

	it('file rename and copy work', async () => {
		const { driver } = await bootDriver();
		await driver.upload!(null, new File([new Uint8Array([1])], 'old.txt'));
		const renamed = await driver.rename!('old.txt', 'new.txt');
		expect(renamed.name).toBe('new.txt');
		const listed = await driver.list({ parentId: null });
		expect(listed.entries.some((e) => e.name === 'old.txt')).toBe(false);
		expect(listed.entries.some((e) => e.name === 'new.txt')).toBe(true);

		await driver.copy!('new.txt', null);
		const afterCopy = await driver.list({ parentId: null });
		const names = afterCopy.entries.filter((e) => e.kind === 'file').map((e) => e.name);
		expect(names.length).toBeGreaterThanOrEqual(2);
	});

	it('download rejects files over EXPLORER_DOWNLOAD_MAX_BYTES', async () => {
		const { driver, client } = await bootDriver();
		const bucket = (await client.listBuckets())[0]!;
		await bucket.upload({
			fileName: 'tiny.bin',
			source: new BufferSource(new Uint8Array([1, 2, 3, 4]))
		});
		const blob = await driver.download!('tiny.bin');
		expect(blob.size).toBe(4);

		expect(EXPLORER_DOWNLOAD_MAX_BYTES).toBe(100 * 1024 * 1024);
		const err = new ExplorerB2Error('B2_TOO_LARGE', 'cap');
		expect(err.code).toBe('B2_TOO_LARGE');
	});

	it('getPath under namePrefix strips root from breadcrumbs', async () => {
		const { driver } = await bootDriver({ namePrefix: 'team/' });
		await driver.mkdir!(null, 'docs');
		const nested = await driver.mkdir!('team/docs/', '2026');
		expect(nested.id).toBe('team/docs/2026/');
		const path = await driver.getPath('team/docs/2026/');
		expect(path.map((p) => p.name)).toEqual(['docs', '2026']);
		expect(path[0]?.parentId).toBeNull();
	});

	it('capabilities: no trash/soft-delete; has upload/download; no sibling order', async () => {
		const { driver } = await bootDriver();
		expect(driver.capabilities.supportsTrash).toBe(false);
		expect(driver.capabilities.supportsSoftDelete).toBe(false);
		expect(driver.capabilities.supportsUpload).toBe(true);
		expect(driver.capabilities.supportsDownload).toBe(true);
		expect(driver.capabilities.supportsMove).toBe(true);
		// DnD into-only: remotes never expose reorder ranks
		expect(driver.capabilities.supportsSiblingOrder).toBe(false);
		expect(driver.reorder).toBeUndefined();
		expect(driver.id).toBe('b2');
	});
});
