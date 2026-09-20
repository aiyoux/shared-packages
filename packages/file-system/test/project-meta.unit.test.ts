import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { packFiles } from '@shared-packages/compress';
import { createVfs, resetSharedVfsForTests } from '../src/index.ts';
import {
	initProject,
	linksFromMeta,
	parseProjectMeta,
	readProjectMeta,
	removeProjectLink,
	upsertProjectLink,
	writeProjectMeta,
	PROJECT_META_FILE,
	PROJECT_META_SCHEMA_VERSION
} from '../src/projectMeta.ts';
import {
	exportProjectAsBundle,
	exportProjectAsFiles,
	importProject
} from '../src/projectExport.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function mk() {
	resetSharedVfsForTests();
	const vfs = createVfs({
		dbName: `project-meta-${Date.now()}-${Math.random()}`,
		memoryOpfs: true,
		requestPersist: false
	});
	await vfs.ready();
	return vfs;
}

async function rawMeta(vfs: ReturnType<typeof createVfs>, rootId: string) {
	const node = (await vfs.list({ parentId: rootId })).find(
		(n) => n.kind === 'file' && n.name === PROJECT_META_FILE
	);
	assert.ok(node, 'expected .project.json on disk');
	return JSON.parse(dec.decode(await vfs.readBytes(node.id))) as Record<string, unknown>;
}

describe('parseProjectMeta', () => {
	it('parses without an id and still returns a project', () => {
		const parsed = parseProjectMeta({ schemaVersion: 1, name: 'Legacy' });
		assert.ok(parsed);
		assert.equal(parsed.name, 'Legacy');
		assert.equal(parsed.id, undefined);
	});

	it('keeps a present id and tolerates extra fields', () => {
		const parsed = parseProjectMeta({
			schemaVersion: 1,
			name: 'N',
			id: 'kept',
			extra: true,
			rooms: [{ id: 'r1', label: 'Design' }],
			currentRoomId: 'r1'
		});
		assert.ok(parsed);
		assert.equal(parsed.id, 'kept');
		assert.equal((parsed as { extra?: boolean }).extra, true);
		assert.deepEqual(parsed.rooms, [{ id: 'r1', label: 'Design' }]);
		assert.equal(parsed.currentRoomId, 'r1');
	});

	it('round-trips extra keys and rooms through JSON', () => {
		const parsed = parseProjectMeta({
			schemaVersion: 1,
			name: 'Poster',
			id: 'pid',
			gossip: { n: 1 },
			rooms: [{ id: 'r1', label: 'Poster' }, { id: 'r2', label: 'Side' }],
			currentRoomId: 'r2'
		});
		assert.ok(parsed);
		const again = parseProjectMeta(JSON.parse(JSON.stringify(parsed)));
		assert.ok(again);
		assert.equal((again as { gossip?: { n: number } }).gossip?.n, 1);
		assert.deepEqual(again.rooms, parsed.rooms);
		assert.equal(again.currentRoomId, 'r2');
	});

	it('parses project-links and keeps them on write-back', () => {
		const parsed = parseProjectMeta({
			schemaVersion: 1,
			name: 'Poster',
			id: 'pid',
			links: [
				{ pairingId: 'aa'.repeat(16), label: 'Sunny River', linkedAt: '2026-09-20T00:00:00.000Z' },
				{ pairingId: '', label: 'bad' },
				{ pairingId: 'bb'.repeat(16), label: 'Quiet Harbor' }
			]
		});
		assert.ok(parsed);
		assert.deepEqual(linksFromMeta(parsed), [
			{ pairingId: 'aa'.repeat(16), label: 'Sunny River', linkedAt: '2026-09-20T00:00:00.000Z' },
			{ pairingId: 'bb'.repeat(16), label: 'Quiet Harbor', linkedAt: '' }
		]);
		const withLink = upsertProjectLink(parsed, {
			pairingId: 'cc'.repeat(16),
			label: 'Cedar Lake',
			linkedAt: '2026-09-20T01:00:00.000Z'
		});
		assert.equal(withLink.links?.length, 3);
		assert.equal(removeProjectLink(withLink, 'aa'.repeat(16)).links?.length, 2);
	});

	it('drops an empty or non-string id rather than failing the parse', () => {
		assert.equal(parseProjectMeta({ name: 'N', id: '' })?.id, undefined);
		assert.equal(parseProjectMeta({ name: 'N', id: 3 })?.id, undefined);
	});

	it('rejects a body that is not a named project', () => {
		assert.equal(parseProjectMeta(null), null);
		assert.equal(parseProjectMeta({ schemaVersion: 1 }), null);
		assert.equal(parseProjectMeta({ name: 1 }), null);
	});
});

describe('project meta id', () => {
	it('mints an id on init and keeps it on re-init', async () => {
		const vfs = await mk();
		const folder = await vfs.mkdir(null, 'Proj');
		const meta = await initProject(vfs, folder.id, { name: 'Proj' });
		assert.equal(meta.schemaVersion, PROJECT_META_SCHEMA_VERSION);
		assert.match(meta.id!, UUID_RE);
		assert.equal(meta.rooms?.length, 1);
		assert.equal(meta.rooms![0]!.label, 'Proj');
		assert.match(meta.rooms![0]!.id, UUID_RE);
		assert.equal(meta.currentRoomId, meta.rooms![0]!.id);
		assert.equal((await rawMeta(vfs, folder.id)).id, meta.id);
		assert.equal((await rawMeta(vfs, folder.id)).currentRoomId, meta.currentRoomId);

		const again = await initProject(vfs, folder.id, { name: 'Renamed' });
		assert.equal(again.id, meta.id);
		assert.equal(again.name, 'Renamed');
		assert.equal(again.currentRoomId, meta.currentRoomId);
		assert.deepEqual(again.rooms, meta.rooms);
		assert.deepEqual(again.links, meta.links);
		await vfs.db.delete();
	});

	it('init preserves existing project-links', async () => {
		const vfs = await mk();
		const folder = await vfs.mkdir(null, 'Proj');
		const link = {
			pairingId: 'aa'.repeat(16),
			label: 'Sunny River',
			linkedAt: '2026-09-20T00:00:00.000Z'
		};
		await writeProjectMeta(vfs, folder.id, {
			schemaVersion: 1,
			name: 'Proj',
			links: [link]
		});
		const again = await initProject(vfs, folder.id, { name: 'Proj' });
		assert.deepEqual(again.links, [link]);
		await vfs.db.delete();
	});

	it('write of id-less meta mints, and a supplied id is kept', async () => {
		const vfs = await mk();
		const folder = await vfs.mkdir(null, 'Proj');
		await writeProjectMeta(vfs, folder.id, { schemaVersion: 1, name: 'X' });
		const minted = await rawMeta(vfs, folder.id);
		assert.equal(minted.name, 'X');
		assert.match(String(minted.id), UUID_RE);

		await writeProjectMeta(vfs, folder.id, {
			schemaVersion: 1,
			name: 'Y',
			id: 'kept-id'
		});
		assert.equal((await rawMeta(vfs, folder.id)).id, 'kept-id');
		await vfs.db.delete();
	});

	it('missing id on open is adopted and written back', async () => {
		const vfs = await mk();
		const folder = await vfs.mkdir(null, 'Proj');
		await vfs.writeFile({
			parentId: folder.id,
			name: PROJECT_META_FILE,
			body: enc.encode(`${JSON.stringify({ schemaVersion: 1, name: 'Old' })}\n`),
			contentType: 'application/json'
		});
		const meta = await readProjectMeta(vfs, folder.id);
		assert.ok(meta);
		assert.equal(meta.name, 'Old');
		assert.match(meta.id!, UUID_RE);
		assert.equal((await rawMeta(vfs, folder.id)).id, meta.id);
		await vfs.db.delete();
	});

	it('round-trips id: two imports of one export keep the same id', async () => {
		const vfs = await mk();
		const folder = await vfs.mkdir(null, 'Proj');
		await vfs.writeFile({
			parentId: folder.id,
			name: 'note.txt',
			body: enc.encode('hi')
		});
		const meta = await initProject(vfs, folder.id, { name: 'Proj' });

		const zip = await exportProjectAsFiles(vfs, folder.id);
		const a = await importProject(vfs, null, zip.bytes, { name: 'Copy A' });
		const b = await importProject(vfs, null, zip.bytes, { name: 'Copy B' });
		assert.equal(a.meta?.id, meta.id);
		assert.equal(b.meta?.id, meta.id);

		const bundle = await exportProjectAsBundle(vfs, folder.id, { skipCompaction: true });
		const c = await importProject(vfs, null, bundle.bytes, { name: 'Copy C' });
		assert.equal(c.meta?.id, meta.id);
		await vfs.db.delete();
	});

	it('import of a project that has no id mints a new one each time', async () => {
		const vfs = await mk();
		const packed = await packFiles(
			'fflate',
			[
				{
					name: PROJECT_META_FILE,
					data: enc.encode(`${JSON.stringify({ schemaVersion: 1, name: 'Legacy' })}\n`)
				},
				{ name: 'a.txt', data: enc.encode('x') }
			],
			'zip'
		);
		const a = await importProject(vfs, null, packed[0]!.data, { name: 'L1' });
		const b = await importProject(vfs, null, packed[0]!.data, { name: 'L2' });
		assert.equal(a.meta?.name, 'Legacy');
		assert.match(a.meta!.id!, UUID_RE);
		assert.match(b.meta!.id!, UUID_RE);
		assert.notEqual(a.meta?.id, b.meta?.id);
		await vfs.db.delete();
	});
});
