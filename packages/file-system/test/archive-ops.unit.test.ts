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
	packedIsTopLevel,
	pickEngineForCodec,
	runArchiveJob,
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
		assert.equal(packedIsTopLevel('hello.txt'), true);
		assert.equal(packedIsTopLevel('nested/inner.txt'), false);
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

	it('writeEntriesToDriver reports dest-file progress', async () => {
		const vfs = createVfs({
			dbName: `archive-ops-progress-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		await driver.ready();
		const ticks: Array<{ name: string; transferred: number; done: boolean }> = [];
		await writeEntriesToDriver(
			driver,
			null,
			[{ path: 'shot.txt', data: enc.encode('snap') }],
			(ev) => ticks.push({ name: ev.name, transferred: ev.transferred, done: ev.done })
		);
		assert.ok(ticks.some((t) => t.name === 'shot.txt' && t.transferred === 0 && !t.done));
		assert.ok(ticks.some((t) => t.name === 'shot.txt' && t.done && t.transferred === 4));
		await vfs.db.delete();
	});

	it('writeEntriesToDriver reports destParentId of the extract folder not root', async () => {
		const vfs = createVfs({
			dbName: `archive-ops-parent-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		await driver.ready();
		const folder = await driver.mkdir!(null, 'Dest');
		const parents: Array<string | null> = [];
		await writeEntriesToDriver(
			driver,
			folder.id,
			[{ path: 'hello.txt', data: enc.encode('hello') }],
			(ev) => parents.push(ev.parentId)
		);
		assert.ok(parents.length);
		assert.ok(parents.every((p) => p === folder.id));
		assert.ok(parents.every((p) => p !== null));
		await vfs.db.delete();
	});

	it('compress job ticks are chip-only; dest rows use the zip name in the dest folder', async () => {
		const vfs = createVfs({
			dbName: `archive-ops-compress-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		await driver.ready();
		const folder = await driver.mkdir!(null, 'shots');
		await driver.writeFile!(folder.id, new File([enc.encode('snap')], 'photo.txt'));
		const listed = await driver.list({ parentId: folder.id });
		const photo = listed.entries.find((e) => e.name === 'photo.txt')!;
		const events: Array<{ name: string; parentId: string | null; job?: boolean }> = [];
		await runArchiveJob({
			kind: 'compress',
			entries: [photo],
			driver,
			dest: 'same',
			destParentId: folder.id,
			title: 'photo.txt',
			outputName: 'photo.zip',
			compressEngineId: 'fflate',
			codec: 'zip',
			cryptoEngineId: 'webcrypto',
			password: '',
			skipSystemFiles: true,
			useHost: false,
			onProgress: (ev) => events.push({ name: ev.name, parentId: ev.parentId, job: ev.job })
		});
		assert.ok(events.some((e) => e.job && e.name === 'photo.txt'));
		const destRows = events.filter((e) => !e.job);
		assert.ok(destRows.length);
		assert.ok(destRows.every((e) => e.parentId === folder.id));
		assert.ok(destRows.every((e) => e.name === 'photo.zip'));
		await vfs.db.delete();
	});

	it('encrypt dest rows are the vault in the dest folder, not the source name', async () => {
		const vfs = createVfs({
			dbName: `archive-ops-encrypt-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		await driver.ready();
		const folder = await driver.mkdir!(null, 'safe');
		await driver.writeFile!(folder.id, new File([enc.encode('secret')], 'note.txt'));
		const listed = await driver.list({ parentId: folder.id });
		const note = listed.entries.find((e) => e.name === 'note.txt')!;
		const events: Array<{ name: string; parentId: string | null; job?: boolean }> = [];
		await runArchiveJob({
			kind: 'encrypt',
			entries: [note],
			driver,
			dest: 'same',
			destParentId: folder.id,
			title: 'note.txt',
			outputName: 'note.spvault',
			compressEngineId: 'fflate',
			codec: 'zip',
			cryptoEngineId: 'webcrypto',
			password: 's3cret',
			skipSystemFiles: true,
			useHost: false,
			onProgress: (ev) => events.push({ name: ev.name, parentId: ev.parentId, job: ev.job })
		});
		assert.ok(events.some((e) => e.job === true));
		const destRows = events.filter((e) => !e.job);
		assert.ok(destRows.every((e) => e.parentId === folder.id));
		assert.ok(destRows.every((e) => e.name === 'note.spvault'));
		await vfs.db.delete();
	});

	it('decompress dest rows are extracted files in the dest folder, not the zip name', async () => {
		const vfs = createVfs({
			dbName: `archive-ops-decompress-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		await driver.ready();
		const folder = await driver.mkdir!(null, 'inbox');
		const zip = await packFiles('fflate', [{ name: 'hello.txt', data: enc.encode('hello') }], 'zip');
		await driver.writeFile!(folder.id, new File([zip[0]!.data as BlobPart], zip[0]!.name));
		const listed = await driver.list({ parentId: folder.id });
		const archive = listed.entries.find((e) => e.name === zip[0]!.name)!;
		const events: Array<{ name: string; parentId: string | null; job?: boolean }> = [];
		await runArchiveJob({
			kind: 'decompress',
			entries: [archive],
			driver,
			dest: 'same',
			destParentId: folder.id,
			title: archive.name,
			compressEngineId: 'fflate',
			codec: 'zip',
			cryptoEngineId: 'webcrypto',
			password: '',
			skipSystemFiles: true,
			useHost: false,
			onProgress: (ev) => events.push({ name: ev.name, parentId: ev.parentId, job: ev.job })
		});
		assert.ok(events.some((e) => e.job && e.name === archive.name));
		const destRows = events.filter((e) => !e.job);
		assert.ok(destRows.length);
		assert.ok(destRows.every((e) => e.parentId === folder.id));
		assert.ok(destRows.every((e) => e.name === 'hello.txt'));
		await vfs.db.delete();
	});

	it('decrypt dest rows are vault members in the dest folder, not the vault name', async () => {
		const vfs = createVfs({
			dbName: `archive-ops-decrypt-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		await driver.ready();
		const folder = await driver.mkdir!(null, 'safe');
		const sealed = await sealVault(
			'webcrypto',
			[{ path: 'secret.txt', data: enc.encode('secret') }],
			's3cret'
		);
		await driver.writeFile!(folder.id, new File([sealed.data as BlobPart], sealed.name));
		const listed = await driver.list({ parentId: folder.id });
		const vault = listed.entries.find((e) => e.name === sealed.name)!;
		const events: Array<{ name: string; parentId: string | null; job?: boolean }> = [];
		await runArchiveJob({
			kind: 'decrypt',
			entries: [vault],
			driver,
			dest: 'same',
			destParentId: folder.id,
			title: vault.name,
			compressEngineId: 'fflate',
			codec: 'zip',
			cryptoEngineId: 'webcrypto',
			password: 's3cret',
			skipSystemFiles: true,
			useHost: false,
			onProgress: (ev) => events.push({ name: ev.name, parentId: ev.parentId, job: ev.job })
		});
		assert.ok(events.some((e) => e.job === true));
		const destRows = events.filter((e) => !e.job);
		assert.ok(destRows.length);
		assert.ok(destRows.every((e) => e.parentId === folder.id));
		assert.ok(destRows.every((e) => e.name === 'secret.txt'));
		assert.ok(destRows.every((e) => e.name !== vault.name));
		await vfs.db.delete();
	});

	it('writeEntriesToDriver stops when the abort signal fires', async () => {
		const vfs = createVfs({
			dbName: `archive-ops-abort-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		await driver.ready();
		const ac = new AbortController();
		ac.abort();
		await assert.rejects(
			() =>
				writeEntriesToDriver(
					driver,
					null,
					[{ path: 'a.txt', data: enc.encode('a') }],
					undefined,
					ac.signal
				),
			(e: unknown) => e instanceof Error && e.name === 'AbortError'
		);
		await vfs.db.delete();
	});

	it('expandPackedBytes reports zip members', async () => {
		const zip = await packFiles(
			'fflate',
			[{ name: 'hello.txt', data: enc.encode('hello') }],
			'zip'
		);
		const seen: string[] = [];
		const files = await expandPackedBytes(zip[0]!.data, zip[0]!.name, undefined, (ev) => {
			if (ev.done) seen.push(ev.path);
		});
		assert.deepEqual(seen, ['hello.txt']);
		assert.equal(files[0]!.path, 'hello.txt');
	});

	it('expandPackedBytes omits __MACOSX sidecar members', async () => {
		const zip = await packFiles(
			'fflate',
			[
				{ name: 'hello.txt', data: enc.encode('hello') },
				{ name: '__MACOSX/._hello.txt', data: enc.encode('appledouble') }
			],
			'zip'
		);
		const files = await expandPackedBytes(zip[0]!.data, zip[0]!.name);
		assert.deepEqual(
			files.map((f) => f.path),
			['hello.txt']
		);
		const kept = await expandPackedBytes(zip[0]!.data, zip[0]!.name, undefined, undefined, {
			skipSystemFiles: false
		});
		assert.deepEqual(
			kept.map((f) => f.path).sort(),
			['__MACOSX/._hello.txt', 'hello.txt']
		);
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
