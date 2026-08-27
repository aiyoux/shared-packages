import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { packFiles } from '@shared-packages/compress';
import { sealVault } from '@shared-packages/crypto';
import { createVfs } from '../src/index.ts';
import { createLocalExplorerDriver } from '../src/ui/localExplorerDriver.ts';
import {
	collectPackEntries,
	createInnerFsSession,
	describeCompressRole,
	expandPackedBytes,
	extractContainerName,
	looksCompressedName,
	looksPackedName,
	looksVaultName,
	packingAsTree,
	packedIsTopLevel,
	pickEngineForCodec,
	previewArchiveEnginePlan,
	runArchiveJob,
	uniqueChildFolderName,
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

/** Driver that can receive files but cannot create folders. */
function noMkdirDriver(writes: string[]): Parameters<typeof writeEntriesToDriver>[0] {
	return {
		id: 'mock-nomkdir',
		capabilities: {
			supportsTrash: false,
			supportsSoftDelete: false,
			supportsRename: false,
			supportsMove: false,
			supportsCopy: false,
			supportsMkdir: false,
			supportsUpload: false,
			supportsDownload: false,
			supportsSiblingOrder: false,
			supportsDragOut: false
		},
		async ready() {},
		async list() {
			return { entries: [], truncated: false };
		},
		async getPath() {
			return [];
		},
		async delete() {},
		async writeFile(
			_parentId: string | null,
			file: File
		) {
			writes.push(file.name);
			return { id: `f${writes.length}`, parentId: _parentId, name: file.name, kind: 'file' };
		}
	} as unknown as Parameters<typeof writeEntriesToDriver>[0];
}

describe('archiveOps', () => {
	it('names an extract subfolder after the archive', () => {
		assert.equal(extractContainerName('photos.zip'), 'photos');
		assert.equal(extractContainerName('src.tar.gz'), 'src');
		assert.equal(extractContainerName('notes.tgz'), 'notes');
		assert.equal(extractContainerName('secret.txt.spvault'), 'secret.txt');
	});

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
		const zipFallback = describeCompressRole('addmaple', 'zip', 'create');
		assert.equal(zipFallback.used, 'fflate');
		assert.equal(zipFallback.fallback, true);
		assert.match(zipFallback.reason ?? '', /cannot create ZIP/i);
		const gzipOk = describeCompressRole('addmaple', 'gzip', 'create');
		assert.equal(gzipOk.used, 'addmaple');
		assert.equal(gzipOk.fallback, false);
	});

	it('previews selected vs fallback library before the job runs', () => {
		const tree = previewArchiveEnginePlan({
			kind: 'compress',
			entries: [fileEntry({ id: '1', name: 'a.txt' }), fileEntry({ id: '2', name: 'b.txt' })],
			compressEngineId: 'addmaple',
			codec: 'zip',
			cryptoEngineId: 'webcrypto',
			useHost: false
		});
		assert.equal(tree.fallback, true);
		assert.match(tree.lines.join(' '), /fflate/i);
		assert.match(tree.lines.join(' '), /AddMaple/i);

		const zip = previewArchiveEnginePlan({
			kind: 'decompress',
			entries: [fileEntry({ id: 'z', name: 'bundle.zip' })],
			compressEngineId: 'addmaple',
			codec: 'gzip',
			cryptoEngineId: 'webcrypto',
			useHost: false
		});
		assert.equal(zip.fallback, true);
		assert.match(zip.lines.join(' '), /ZIP/i);
		assert.match(zip.lines.join(' '), /fflate/i);

		const tgz = previewArchiveEnginePlan({
			kind: 'decompress',
			entries: [fileEntry({ id: 'g', name: 'src.tar.gz' })],
			compressEngineId: 'zipkit',
			codec: 'gzip',
			cryptoEngineId: 'webcrypto',
			useHost: false
		});
		assert.equal(tgz.fallback, true);
		assert.match(tgz.lines.join(' '), /TAR/i);

		const vault = previewArchiveEnginePlan({
			kind: 'decrypt',
			entries: [fileEntry({ id: 'v', name: 'secret.spvault' })],
			compressEngineId: 'fflate',
			codec: 'zip',
			cryptoEngineId: 'webcrypto',
			useHost: false
		});
		assert.equal(vault.fallback, false);
		assert.match(vault.lines.join(' '), /recorded in the vault/i);
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

	it('writeEntriesToDriver throws on nested entries for a mkdir-less driver', async () => {
		const writes: string[] = [];
		const driver = noMkdirDriver(writes);
		// No silent dir__file flattening — same refusal as dropping a folder in.
		await assert.rejects(
			writeEntriesToDriver(driver, null, [
				{ path: 'trip/inner/a.txt', data: enc.encode('a') },
				{ path: 'trip/b.txt', data: enc.encode('b') }
			]),
			/cannot create folders/i
		);
		assert.deepEqual(writes, []);
	});

	it('writeEntriesToDriver still extracts flat entries for a mkdir-less driver', async () => {
		const writes: string[] = [];
		const driver = noMkdirDriver(writes);
		await writeEntriesToDriver(driver, null, [
			{ path: 'a.txt', data: enc.encode('a') },
			{ path: 'b.txt', data: enc.encode('b') }
		]);
		assert.deepEqual(writes.sort(), ['a.txt', 'b.txt']);
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
		const expandJob = events.filter((e) => e.job);
		assert.ok(expandJob.length);
		await vfs.db.delete();
	});

	it('wrapInSubfolder extracts into a new folder named after the zip', async () => {
		const vfs = createVfs({
			dbName: `archive-ops-wrap-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		await driver.ready();
		const folder = await driver.mkdir!(null, 'inbox');
		const zip = await packFiles(
			'fflate',
			[
				{ name: 'hello.txt', data: enc.encode('hello') },
				{ name: 'nested/inner.txt', data: enc.encode('inner') }
			],
			'zip'
		);
		await driver.writeFile!(folder.id, new File([zip[0]!.data as BlobPart], zip[0]!.name));
		const listed = await driver.list({ parentId: folder.id });
		const archive = listed.entries.find((e) => e.name === zip[0]!.name)!;
		const stem = extractContainerName(archive.name);
		assert.equal(await uniqueChildFolderName(driver, folder.id, stem), stem);
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
			wrapInSubfolder: true,
			useHost: false
		});
		const kids = await driver.list({ parentId: folder.id });
		assert.equal(kids.entries.some((e) => e.name === 'hello.txt'), false);
		const wrapped = kids.entries.find((e) => e.name === stem && e.kind === 'folder');
		assert.ok(wrapped);
		const inner = await driver.list({ parentId: wrapped.id });
		assert.ok(inner.entries.some((e) => e.name === 'hello.txt'));
		assert.ok(inner.entries.some((e) => e.name === 'nested' && e.kind === 'folder'));
		assert.equal(await uniqueChildFolderName(driver, folder.id, stem), `${stem} (1)`);
		await vfs.db.delete();
	});

	it('nested extract dest rows wait for writeOut; expand job stays under 100%', async () => {
		const vfs = createVfs({
			dbName: `archive-ops-nested-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		await driver.ready();
		const folder = await driver.mkdir!(null, 'inbox');
		const zip = await packFiles(
			'fflate',
			[
				{ name: 'repo/a.txt', data: enc.encode('aaaa') },
				{ name: 'repo/nested/b.txt', data: enc.encode('bbbb') }
			],
			'zip'
		);
		await driver.writeFile!(folder.id, new File([zip[0]!.data as BlobPart], zip[0]!.name));
		const listed = await driver.list({ parentId: folder.id });
		const archive = listed.entries.find((e) => e.name === zip[0]!.name)!;
		const events: Array<{
			name: string;
			parentId: string | null;
			job?: boolean;
			done: boolean;
			transferred: number;
			size: number;
			entryKind?: string;
		}> = [];
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
			onProgress: (ev) =>
				events.push({
					name: ev.name,
					parentId: ev.parentId,
					job: ev.job,
					done: ev.done,
					transferred: ev.transferred,
					size: ev.size,
					entryKind: ev.entryKind
				})
		});
		const jobBeforeDone = events.filter((e) => e.job && !e.done);
		assert.ok(jobBeforeDone.length);
		assert.ok(
			jobBeforeDone.every((e) => e.size <= 0 || e.transferred / e.size < 1),
			'expand/write ticks must not report 100% before the job finishes'
		);
		const destRows = events.filter((e) => !e.job);
		assert.ok(destRows.some((e) => e.name === 'a.txt'));
		assert.ok(destRows.some((e) => e.name === 'b.txt'));
		assert.ok(destRows.some((e) => e.parentId !== folder.id), 'nested file writes to a subfolder');
		const repoFolder = destRows.filter((e) => e.entryKind === 'folder' && e.name === 'repo');
		assert.ok(repoFolder.length, 'dest listing paints the extract folder');
		assert.ok(repoFolder.some((e) => e.parentId === folder.id));
		assert.ok(repoFolder.some((e) => !e.done), 'folder bar moves before all children land');
		assert.ok(repoFolder.some((e) => e.done), 'folder bar completes after its children');
		const nestedFolder = destRows.filter((e) => e.entryKind === 'folder' && e.name === 'nested');
		assert.ok(nestedFolder.length, 'nested folders report their own child progress');
		const kids = await driver.list({ parentId: folder.id });
		const repo = kids.entries.find((e) => e.name === 'repo' && e.kind === 'folder');
		assert.ok(repo);
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

	it('writeEntriesToDriver throws TRASH_STATE if the dest folder is trashed mid-job', async () => {
		const vfs = createVfs({
			dbName: `archive-ops-trash-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		await driver.ready();
		const folder = await driver.mkdir!(null, 'Dest');
		await vfs.trash(folder.id);
		await assert.rejects(
			() =>
				writeEntriesToDriver(driver, folder.id, [{ path: 'nested/a.txt', data: enc.encode('a') }]),
			(e: unknown) => e instanceof Error && 'code' in e && (e as { code: string }).code === 'TRASH_STATE'
		);
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

	it('expandPackedBytes falls back from AddMaple to fflate for ZIP and reports it', async () => {
		const zip = await packFiles(
			'fflate',
			[{ name: 'hello.txt', data: enc.encode('hello') }],
			'zip'
		);
		const roles: Array<{ used: string; fallback: boolean }> = [];
		const files = await expandPackedBytes(zip[0]!.data, zip[0]!.name, undefined, undefined, {
			compressEngineId: 'addmaple',
			onEngine: (role) => roles.push({ used: role.used, fallback: role.fallback })
		});
		assert.equal(files[0]?.path, 'hello.txt');
		assert.ok(roles.some((r) => r.used === 'fflate' && r.fallback));
	});

	it('expandPackedBytes unwraps tar.gz with tar member ticks and a tar library fallback', async () => {
		const tar = await packFiles('tarjs', [{ name: 'nested/a.txt', data: enc.encode('alpha') }], 'tar');
		const gz = await packFiles('fflate', [{ name: tar[0]!.name, data: tar[0]!.data }], 'gzip');
		const seen: string[] = [];
		const roles: Array<{ used: string; action: string; fallback: boolean }> = [];
		const files = await expandPackedBytes(gz[0]!.data, 'src.tar.gz', undefined, (ev) => {
			if (ev.done) seen.push(ev.path);
		}, {
			compressEngineId: 'addmaple',
			onEngine: (role) => roles.push({ used: role.used, action: role.action, fallback: role.fallback })
		});
		assert.deepEqual(
			files.map((f) => f.path),
			['nested/a.txt']
		);
		assert.ok(seen.includes('nested/a.txt'));
		assert.ok(roles.some((r) => r.used === 'addmaple' && r.fallback === false));
		assert.ok(roles.some((r) => r.used === 'tarjs' && r.fallback));
	});

	it('compress job with AddMaple+ZIP uses fflate and stays under 100% until write finishes', async () => {
		const vfs = createVfs({
			dbName: `archive-ops-fallback-zip-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		await driver.ready();
		await driver.writeFile!(null, new File([enc.encode('snap')], 'photo.txt'));
		const listed = await driver.list({ parentId: null });
		const photo = listed.entries.find((e) => e.name === 'photo.txt')!;
		const events: Array<{ job?: boolean; done: boolean; transferred: number; size: number; note?: string }> = [];
		const result = await runArchiveJob({
			kind: 'compress',
			entries: [photo],
			driver,
			dest: 'same',
			destParentId: null,
			title: 'photo.txt',
			outputName: 'photo.zip',
			compressEngineId: 'addmaple',
			codec: 'zip',
			cryptoEngineId: 'webcrypto',
			password: '',
			skipSystemFiles: true,
			useHost: false,
			onProgress: (ev) =>
				events.push({
					job: ev.job,
					done: ev.done,
					transferred: ev.transferred,
					size: ev.size,
					note: ev.note
				})
		});
		assert.equal(result.engines[0]?.used, 'fflate');
		assert.equal(result.engines[0]?.fallback, true);
		assert.ok(events.some((e) => e.job && e.note && /fflate/i.test(e.note) && /AddMaple/i.test(e.note)));
		const jobBeforeDone = events.filter((e) => e.job && !e.done);
		assert.ok(jobBeforeDone.length);
		assert.ok(jobBeforeDone.every((e) => e.size <= 0 || e.transferred / e.size < 1));
		const kids = await driver.list({ parentId: null });
		assert.ok(kids.entries.some((e) => e.name === 'photo.zip'));
		await vfs.db.delete();
	});

	it('decompress job honors the dialog library and reports a codec fallback', async () => {
		const vfs = createVfs({
			dbName: `archive-ops-decomp-fallback-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		await driver.ready();
		const zip = await packFiles('fflate', [{ name: 'hello.txt', data: enc.encode('hello') }], 'zip');
		await driver.writeFile!(null, new File([zip[0]!.data as BlobPart], zip[0]!.name));
		const listed = await driver.list({ parentId: null });
		const archive = listed.entries.find((e) => e.name === zip[0]!.name)!;
		const notes: string[] = [];
		const result = await runArchiveJob({
			kind: 'decompress',
			entries: [archive],
			driver,
			dest: 'same',
			destParentId: null,
			title: archive.name,
			compressEngineId: 'addmaple',
			codec: 'gzip',
			cryptoEngineId: 'webcrypto',
			password: '',
			skipSystemFiles: true,
			useHost: false,
			onProgress: (ev) => {
				if (ev.job && ev.note) notes.push(ev.note);
			}
		});
		assert.ok(result.engines.some((e) => e.used === 'fflate' && e.fallback));
		assert.ok(notes.some((n) => /fflate/i.test(n) && /AddMaple/i.test(n)));
		await vfs.db.delete();
	});

	it('decrypt job reports the vault header library and writes after expand', async () => {
		const vfs = createVfs({
			dbName: `archive-ops-decrypt-engine-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		await driver.ready();
		const sealed = await sealVault(
			'webcrypto',
			[{ path: 'secret.txt', data: enc.encode('secret') }],
			's3cret'
		);
		await driver.writeFile!(null, new File([sealed.data as BlobPart], sealed.name));
		const listed = await driver.list({ parentId: null });
		const vault = listed.entries.find((e) => e.name === sealed.name)!;
		const events: Array<{ job?: boolean; done: boolean; transferred: number; size: number; note?: string }> = [];
		const result = await runArchiveJob({
			kind: 'decrypt',
			entries: [vault],
			driver,
			dest: 'same',
			destParentId: null,
			title: vault.name,
			compressEngineId: 'fflate',
			codec: 'zip',
			cryptoEngineId: 'libsodium',
			password: 's3cret',
			skipSystemFiles: true,
			useHost: false,
			onProgress: (ev) =>
				events.push({
					job: ev.job,
					done: ev.done,
					transferred: ev.transferred,
					size: ev.size,
					note: ev.note
				})
		});
		assert.equal(result.engines[0]?.used, 'webcrypto');
		assert.equal(result.engines[0]?.fallback, false);
		assert.ok(events.some((e) => e.job && e.note && /Web Crypto/i.test(e.note)));
		const jobBeforeDone = events.filter((e) => e.job && !e.done);
		assert.ok(jobBeforeDone.every((e) => e.size <= 0 || e.transferred / e.size < 1));
		await vfs.db.delete();
	});

	it('popup extract writes the inner filesystem before the job reports done', async () => {
		const vfs = createVfs({
			dbName: `archive-ops-popup-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		await driver.ready();
		const zip = await packFiles(
			'fflate',
			[
				{ name: 'hello.txt', data: enc.encode('hello') },
				{ name: 'nested/inner.txt', data: enc.encode('inner') }
			],
			'zip'
		);
		await driver.writeFile!(null, new File([zip[0]!.data as BlobPart], zip[0]!.name));
		const listed = await driver.list({ parentId: null });
		const archive = listed.entries.find((e) => e.name === zip[0]!.name)!;
		const events: Array<{ job?: boolean; done: boolean; transferred: number; size: number }> = [];
		const result = await runArchiveJob({
			kind: 'decompress',
			entries: [archive],
			driver,
			dest: 'popup',
			destParentId: null,
			title: archive.name,
			compressEngineId: 'fflate',
			codec: 'zip',
			cryptoEngineId: 'webcrypto',
			password: '',
			skipSystemFiles: true,
			useHost: false,
			onProgress: (ev) =>
				events.push({
					job: ev.job,
					done: ev.done,
					transferred: ev.transferred,
					size: ev.size
				})
		});
		assert.ok(result.innerSession);
		const jobBeforeDone = events.filter((e) => e.job && !e.done);
		assert.ok(jobBeforeDone.every((e) => e.size <= 0 || e.transferred / e.size < 1));
		const inner = await result.innerSession!.driver.list({ parentId: null });
		assert.ok(inner.entries.some((e) => e.name === 'hello.txt'));
		await result.innerSession!.dispose();
		await vfs.db.delete();
	});

	it('writeEntriesToDriver stops mid-tree when the abort signal fires', async () => {
		const vfs = createVfs({
			dbName: `archive-ops-abort-write-${Date.now()}-${Math.random()}`,
			memoryOpfs: true,
			requestPersist: false
		});
		await vfs.ready();
		const driver = createLocalExplorerDriver(vfs);
		await driver.ready();
		const ac = new AbortController();
		const files = Array.from({ length: 24 }, (_, i) => ({
			path: `tree/f${i}.txt`,
			data: enc.encode(`x${i}`)
		}));
		let seen = 0;
		await assert.rejects(
			() =>
				writeEntriesToDriver(
					driver,
					null,
					files,
					() => {
						seen += 1;
						if (seen >= 4) ac.abort();
					},
					ac.signal
				),
			(e: unknown) => e instanceof Error && e.name === 'AbortError'
		);
		assert.ok(seen >= 4);
		const root = await driver.list({ parentId: null });
		const tree = root.entries.find((e) => e.name === 'tree' && e.kind === 'folder');
		assert.ok(tree);
		const kids = await driver.list({ parentId: tree.id });
		assert.ok(kids.entries.length < 24);
		await vfs.db.delete();
	});
});
