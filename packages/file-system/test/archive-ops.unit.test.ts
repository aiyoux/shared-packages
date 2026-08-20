import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { packFiles } from '@shared-packages/compress';
import { sealVault } from '@shared-packages/crypto';
import { createVfs } from '../src/index.ts';
import { createLocalExplorerDriver } from '../src/ui/localExplorerDriver.ts';
import {
	collectPackEntries,
	createInnerFsSession,
	expandPackedBytes,
	looksCompressedName,
	looksPackedName,
	looksVaultName,
	packingAsTree,
	pickEngineForCodec,
	subjectLabel,
	writeEntriesToDriver
} from '../src/ui/archiveOps.ts';
import type { ExplorerEntry } from '../src/ui/explorerDriver.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

function fileEntry(partial: Partial<ExplorerEntry> & Pick<ExplorerEntry, 'id' | 'name'>): ExplorerEntry {
	return {
		parentId: null,
		kind: 'file',
		...partial
	};
}

describe('archiveOps', () => {
	it('recognizes compressed and vault names', () => {
		assert.equal(looksCompressedName('notes.txt.gz'), true);
		assert.equal(looksCompressedName('bundle.zip'), true);
		assert.equal(looksCompressedName('notes.txt'), false);
		assert.equal(looksVaultName('secret.spvault'), true);
		assert.equal(looksVaultName('secret.zip'), false);
		assert.equal(looksPackedName('a.zst'), true);
		assert.equal(looksPackedName('a.spvault'), true);
		assert.equal(looksPackedName('a.txt'), false);
	});

	it('picks an engine that supports the codec', () => {
		assert.equal(pickEngineForCodec('addmaple', 'zip'), 'fflate');
		assert.equal(pickEngineForCodec('fflate', 'gzip'), 'fflate');
	});

	it('treats folders and multi-select as a tree pack', () => {
		assert.equal(packingAsTree([fileEntry({ id: '1', name: 'a.txt' })]), false);
		assert.equal(
			packingAsTree([fileEntry({ id: '1', name: 'a.txt' }), fileEntry({ id: '2', name: 'b.txt' })]),
			true
		);
		assert.equal(packingAsTree([{ id: 'd', name: 'Docs', kind: 'folder', parentId: null }]), true);
		assert.equal(subjectLabel([fileEntry({ id: '1', name: 'a.txt' })]), 'a.txt');
		assert.equal(
			subjectLabel([fileEntry({ id: '1', name: 'a.txt' }), fileEntry({ id: '2', name: 'b.txt' })]),
			'2 items'
		);
	});

	it('collects a folder tree and writes nested paths', async () => {
		const vfs = createVfs({
			dbName: `archive-ops-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		await driver.ready();
		const folder = await driver.mkdir!(null, 'Docs');
		await driver.writeFile!(folder.id, new File([enc.encode('alpha')], 'a.txt'));
		const nested = await driver.mkdir!(folder.id, 'nested');
		await driver.writeFile!(nested.id, new File([enc.encode('beta')], 'b.txt'));
		const listed = await driver.list({ parentId: null });
		const docs = listed.entries.find((e) => e.name === 'Docs')!;
		const packed = await collectPackEntries(driver, [docs]);
		assert.deepEqual(
			packed.map((p) => p.path).sort(),
			['Docs/a.txt', 'Docs/nested/b.txt']
		);

		const dest = createVfs({
			dbName: `archive-ops-dest-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await dest.ready();
		const destDriver = createLocalExplorerDriver(dest);
		await destDriver.ready();
		await writeEntriesToDriver(destDriver, null, packed);
		const root = await destDriver.list({ parentId: null });
		const destDocs = root.entries.find((e) => e.name === 'Docs' && e.kind === 'folder');
		assert.ok(destDocs);
		const destKids = await destDriver.list({ parentId: destDocs.id });
		assert.ok(destKids.entries.some((e) => e.name === 'a.txt'));
		const destNested = destKids.entries.find((e) => e.name === 'nested');
		assert.ok(destNested);
		const inner = await destDriver.list({ parentId: destNested.id });
		assert.equal(inner.entries[0]?.name, 'b.txt');
		await vfs.db.delete();
		await dest.db.delete();
	});

	it('expands a zip and a vault tree into an inner filesystem', async () => {
		const zip = await packFiles(
			'fflate',
			[
				{ name: 'hello.txt', data: enc.encode('hello') },
				{ name: 'nested/inner.txt', data: enc.encode('inner') }
			],
			'zip'
		);
		const zipFiles = await expandPackedBytes(zip[0]!.data, zip[0]!.name);
		assert.deepEqual(
			zipFiles.map((f) => f.path).sort(),
			['hello.txt', 'nested/inner.txt']
		);

		const sealed = await sealVault(
			'webcrypto',
			[
				{ path: 'one.txt', data: enc.encode('one') },
				{ path: 'dir/two.txt', data: enc.encode('two') }
			],
			's3cret',
			{ kind: 'tree' }
		);
		const vaultFiles = await expandPackedBytes(sealed.data, sealed.name, 's3cret');
		assert.deepEqual(
			vaultFiles.map((f) => f.path).sort(),
			['dir/two.txt', 'one.txt']
		);

		const session = await createInnerFsSession('archive.zip', zipFiles);
		const listed = await session.driver.list({ parentId: null });
		assert.ok(listed.entries.some((e) => e.name === 'hello.txt' && e.kind === 'file'));
		const folder = listed.entries.find((e) => e.name === 'nested' && e.kind === 'folder');
		assert.ok(folder);
		const nested = await session.driver.list({ parentId: folder.id });
		assert.equal(nested.entries[0]?.name, 'inner.txt');
		const blob = await session.driver.readBlob!(nested.entries[0]!.id);
		assert.equal(dec.decode(new Uint8Array(await blob.arrayBuffer())), 'inner');
		await session.dispose();
	});
});
