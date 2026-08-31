/**
 * SQLite catalog with a Dexie-shaped table API so VfsService, packs, GC, and
 * tests keep calling `vfs.db.nodes.get` / `transaction` / etc.
 *
 * Browser: live OPFS SAH-pool connection in a dedicated worker (COMMIT is
 * durable). Tests / memory: in-process sqlite-wasm `:memory:`.
 */
import { ROOT_PARENT_KEY } from './db.js';
import type { AppDraft, BlobRef, VfsNode } from './types.js';
import type { MetaRow, LeaseRow } from './db.js';
import type { OpfsBlobStore } from './opfs.js';
import {
	engineFromPort,
	openMemoryEngine,
	openWorkerEngine,
	type SqlEngine
} from './catalogEngine.js';

export const CATALOG_OPFS_PATH = 'meta/catalog.sqlite';
export const MIGRATED_KEY = 'migrated_from_idb';

function jsonOrNull(v: unknown): string | null {
	if (v === undefined) return null;
	return JSON.stringify(v);
}

function parseJson<T>(raw: unknown, fallback: T): T {
	if (raw == null || raw === '') return fallback;
	if (typeof raw !== 'string') return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

function decodeNode(r: Record<string, unknown>): VfsNode {
	const parentId = (r.parent_id as string | null) ?? null;
	const node: VfsNode = {
		id: String(r.id),
		parentId,
		parentKey: parentId ?? ROOT_PARENT_KEY,
		name: String(r.name),
		kind: r.kind === 'folder' ? 'folder' : 'file',
		createdAt: Number(r.created_at) || 0,
		updatedAt: Number(r.updated_at) || 0,
		generation: Number(r.generation) || 1
	};
	if (r.file_type) node.fileType = r.file_type as VfsNode['fileType'];
	if (r.size != null) node.size = Number(r.size);
	if (r.content_type) node.contentType = String(r.content_type);
	if (r.blob_id) node.blobId = String(r.blob_id);
	const meta = parseJson<Record<string, unknown> | null>(r.meta, null);
	if (meta) node.meta = meta;
	if (r.deleted_at != null) node.deletedAt = Number(r.deleted_at);
	if (r.trash_parent_id !== undefined)
		node.trashParentId = (r.trash_parent_id as string | null) ?? null;
	if (r.sort_order != null) node.sortOrder = Number(r.sort_order);
	return node;
}

function decodeBlob(r: Record<string, unknown>): BlobRef {
	const ref: BlobRef = {
		id: String(r.id),
		opfsPath: String(r.opfs_path),
		byteLength: Number(r.byte_length) || 0,
		createdAt: Number(r.created_at) || 0
	};
	if (r.content_type) ref.contentType = String(r.content_type);
	ref.pendingPromote = !!r.pending_promote;
	ref.pending = !!r.pending;
	if (r.pack_offset != null) ref.packOffset = Number(r.pack_offset);
	if (r.crc32 != null) ref.crc32 = Number(r.crc32);
	if (r.pack_generation != null) ref.packGeneration = Number(r.pack_generation);
	return ref;
}

function decodeDraft(r: Record<string, unknown>): AppDraft {
	const d: AppDraft = {
		id: String(r.id),
		appId: String(r.app_id ?? ''),
		updatedAt: Number(r.updated_at) || 0,
		payload: parseJson(r.payload, null)
	};
	if (r.open_file_id) d.openFileId = String(r.open_file_id);
	if (r.open_file_generation != null) d.openFileGeneration = Number(r.open_file_generation);
	return d;
}

export class SqlCollection<T> {
	private readonly fetch: () => Promise<T[]>;
	constructor(fetch: () => Promise<T[]>) {
		this.fetch = fetch;
	}
	async toArray(): Promise<T[]> {
		return this.fetch();
	}
	filter(pred: (t: T) => boolean): SqlCollection<T> {
		return new SqlCollection(async () => (await this.fetch()).filter(pred));
	}
	and(pred: (t: T) => boolean): SqlCollection<T> {
		return this.filter(pred);
	}
	async first(): Promise<T | undefined> {
		return (await this.fetch())[0];
	}
	async last(): Promise<T | undefined> {
		const rows = await this.fetch();
		return rows[rows.length - 1];
	}
	async each(fn: (t: T) => void | Promise<void>): Promise<void> {
		for (const row of await this.fetch()) await fn(row);
	}
}

type WhereClause = { sql: string; params: unknown[] };

export class SqliteCatalog {
	readonly name: string;
	private engine: SqlEngine | null = null;
	private txDepth = 0;
	private catalogPort: MessagePort | null = null;
	/** False until migrate ran successfully (or a fresh catalog was stamped). GC must skip. */
	migrationOk = false;
	nodes!: NodeTable;
	blobRefs!: BlobTable;
	drafts!: DraftTable;
	meta!: MetaTable;
	leases!: LeaseTable;

	constructor(name: string, opts?: { catalogPort?: MessagePort | null }) {
		this.name = name;
		this.catalogPort = opts?.catalogPort ?? null;
		this.nodes = new NodeTable(this);
		this.blobRefs = new BlobTable(this);
		this.drafts = new DraftTable(this);
		this.meta = new MetaTable(this);
		this.leases = new LeaseTable(this);
	}

	private eng(): SqlEngine {
		if (!this.engine) throw new Error('SqliteCatalog not open');
		return this.engine;
	}

	async open(): Promise<void> {
		if (this.engine) return;
		this.engine = await openMemoryEngine(this.name);
	}

	async openWithStore(_opfs: OpfsBlobStore, persist: boolean): Promise<void> {
		if (this.engine) return;
		if (this.catalogPort) {
			this.engine = engineFromPort(this.catalogPort, this.name);
			await this.engine.exec('SELECT 1 AS ok');
			return;
		}
		if (persist) {
			const worker = await openWorkerEngine(this.name);
			if (!worker) {
				throw new Error('Live OPFS catalog is unavailable (SAH worker / COOP)');
			}
			await worker.exec('SELECT 1 AS ok');
			this.engine = worker;
			return;
		}
		this.engine = await openMemoryEngine(this.name);
	}

	/** Live SAH COMMIT is durable; kept so callers can still await it. */
	async persist(): Promise<void> {}

	inTx(): boolean {
		return this.txDepth > 0;
	}

	/** Other tabs re-query after BroadcastChannel. No dump to reload. */
	async reloadFromOpfs(): Promise<void> {}

	async exec(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
		return this.eng().exec(sql, params);
	}

	async run(sql: string, params: unknown[] = []): Promise<void> {
		await this.eng().run(sql, params);
	}

	async transaction<T>(_mode: string, ...rest: unknown[]): Promise<T> {
		const fn = rest[rest.length - 1] as () => Promise<T> | T;
		this.txDepth += 1;
		const started = this.txDepth === 1;
		if (started) await this.eng().begin();
		try {
			const result = await fn();
			if (started) {
				await this.eng().commit();
				this.txDepth -= 1;
			} else {
				this.txDepth -= 1;
			}
			return result;
		} catch (e) {
			if (started) await this.eng().rollback();
			this.txDepth -= 1;
			throw e;
		}
	}

	close(): void {
		void this.engine?.close();
		this.engine = null;
	}

	async delete(): Promise<void> {
		if (this.engine) await this.engine.wipe();
		else this.engine = await openMemoryEngine(this.name);
		this.migrationOk = true;
	}
}

class NodeTable {
	private readonly c: SqliteCatalog;
	constructor(c: SqliteCatalog) {
		this.c = c;
	}

	async get(id: string): Promise<VfsNode | undefined> {
		const rows = await this.c.exec('SELECT * FROM nodes WHERE id = ?', [id]);
		return rows[0] ? decodeNode(rows[0]) : undefined;
	}

	async put(node: VfsNode): Promise<string> {
		const parentId = node.parentId ?? null;
		await this.c.run(
			`INSERT INTO nodes (id, parent_id, name, kind, file_type, size, content_type, created_at, updated_at, generation, blob_id, meta, deleted_at, trash_parent_id, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         parent_id=excluded.parent_id, name=excluded.name, kind=excluded.kind, file_type=excluded.file_type,
         size=excluded.size, content_type=excluded.content_type, created_at=excluded.created_at,
         updated_at=excluded.updated_at, generation=excluded.generation, blob_id=excluded.blob_id,
         meta=excluded.meta, deleted_at=excluded.deleted_at, trash_parent_id=excluded.trash_parent_id,
         sort_order=excluded.sort_order`,
			[
				node.id,
				parentId,
				node.name,
				node.kind,
				node.fileType ?? null,
				node.size ?? null,
				node.contentType ?? null,
				node.createdAt,
				node.updatedAt,
				node.generation,
				node.blobId ?? null,
				jsonOrNull(node.meta),
				node.deletedAt ?? null,
				node.trashParentId === undefined ? null : node.trashParentId,
				node.sortOrder ?? null
			]
		);
		if (!this.c.inTx()) await this.c.persist();
		return node.id;
	}

	async bulkPut(nodes: VfsNode[]): Promise<void> {
		if (!nodes.length) return;
		if (this.c.inTx()) {
			for (const n of nodes) await this.put(n);
			return;
		}
		await this.c.transaction('rw', async () => {
			for (const n of nodes) await this.put(n);
		});
	}

	async bulkGet(ids: string[]): Promise<Array<VfsNode | undefined>> {
		return Promise.all(ids.map((id) => this.get(id)));
	}

	async bulkDelete(ids: string[]): Promise<void> {
		if (!ids.length) return;
		for (const id of ids) await this.c.run('DELETE FROM nodes WHERE id = ?', [id]);
		if (!this.c.inTx()) await this.c.persist();
	}

	async delete(id: string): Promise<void> {
		await this.c.run('DELETE FROM nodes WHERE id = ?', [id]);
		if (!this.c.inTx()) await this.c.persist();
	}

	async toArray(): Promise<VfsNode[]> {
		return (await this.c.exec('SELECT * FROM nodes')).map(decodeNode);
	}

	async clear(): Promise<void> {
		await this.c.run('DELETE FROM nodes');
		if (!this.c.inTx()) await this.c.persist();
	}

	async update(id: string, mods: Partial<VfsNode>): Promise<number> {
		const cur = await this.get(id);
		if (!cur) return 0;
		await this.put({ ...cur, ...mods, id });
		return 1;
	}

	filter(pred: (n: VfsNode) => boolean): SqlCollection<VfsNode> {
		return new SqlCollection(async () =>
			(await this.c.exec('SELECT * FROM nodes')).map(decodeNode).filter(pred)
		);
	}

	where(index: string): NodeWhere {
		return new NodeWhere(this.c, index);
	}
}

class NodeWhere {
	private readonly c: SqliteCatalog;
	private readonly index: string;
	constructor(c: SqliteCatalog, index: string) {
		this.c = c;
		this.index = index;
	}

	equals(value: unknown): SqlCollection<VfsNode> {
		const clause = this.equalsClause(value);
		return new SqlCollection(async () =>
			(await this.c.exec(`SELECT * FROM nodes WHERE ${clause.sql}`, clause.params)).map(decodeNode)
		);
	}

	anyOf(values: unknown[]): SqlCollection<VfsNode> {
		if (!values.length) return new SqlCollection(async () => []);
		if (this.index === 'parentId' || this.index === 'parentKey') {
			const ids = values.map((v) => (v === ROOT_PARENT_KEY ? null : v));
			const ph = ids.map(() => '?').join(',');
			return new SqlCollection(async () =>
				(await this.c.exec(`SELECT * FROM nodes WHERE parent_id IN (${ph})`, ids)).map(decodeNode)
			);
		}
		const ph = values.map(() => '?').join(',');
		return new SqlCollection(async () =>
			(await this.c.exec(`SELECT * FROM nodes WHERE ${this.col()} IN (${ph})`, values)).map(
				decodeNode
			)
		);
	}

	between(lo: unknown, hi: unknown): SqlCollection<VfsNode> {
		if (this.index === '[parentId+sortOrder]' && Array.isArray(lo) && Array.isArray(hi)) {
			const parentId = lo[0];
			return new SqlCollection(async () =>
				(
					await this.c.exec(
						'SELECT * FROM nodes WHERE parent_id = ? ORDER BY sort_order ASC',
						[parentId]
					)
				).map(decodeNode)
			);
		}
		return new SqlCollection(async () => []);
	}

	private col(): string {
		if (this.index === 'id') return 'id';
		if (this.index === 'name') return 'name';
		if (this.index === 'kind') return 'kind';
		if (this.index === 'fileType') return 'file_type';
		if (this.index === 'updatedAt') return 'updated_at';
		if (this.index === 'deletedAt') return 'deleted_at';
		return 'id';
	}

	private equalsClause(value: unknown): WhereClause {
		if (this.index === 'parentId') {
			if (value == null) return { sql: 'parent_id IS NULL', params: [] };
			return { sql: 'parent_id = ?', params: [value] };
		}
		if (this.index === 'parentKey') {
			if (value == null || value === ROOT_PARENT_KEY)
				return { sql: 'parent_id IS NULL', params: [] };
			return { sql: 'parent_id = ?', params: [value] };
		}
		if (this.index === '[parentKey+name]' || this.index === '[parentId+name]') {
			const pair = value as [unknown, string];
			const key = pair[0];
			const name = pair[1];
			if (key == null || key === ROOT_PARENT_KEY)
				return { sql: 'parent_id IS NULL AND name = ?', params: [name] };
			return { sql: 'parent_id = ? AND name = ?', params: [key, name] };
		}
		if (this.index === 'id') return { sql: 'id = ?', params: [value] };
		return { sql: `${this.col()} = ?`, params: [value] };
	}
}

class BlobTable {
	private readonly c: SqliteCatalog;
	constructor(c: SqliteCatalog) {
		this.c = c;
	}

	async get(id: string): Promise<BlobRef | undefined> {
		const rows = await this.c.exec('SELECT * FROM blob_refs WHERE id = ?', [id]);
		return rows[0] ? decodeBlob(rows[0]) : undefined;
	}

	async put(ref: BlobRef): Promise<string> {
		await this.c.run(
			`INSERT INTO blob_refs (id, opfs_path, byte_length, created_at, content_type, pending_promote, pending, pack_offset, crc32, pack_generation)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         opfs_path=excluded.opfs_path, byte_length=excluded.byte_length, created_at=excluded.created_at,
         content_type=excluded.content_type, pending_promote=excluded.pending_promote, pending=excluded.pending,
         pack_offset=excluded.pack_offset, crc32=excluded.crc32, pack_generation=excluded.pack_generation`,
			[
				ref.id,
				ref.opfsPath,
				ref.byteLength,
				ref.createdAt,
				ref.contentType ?? null,
				ref.pendingPromote ? 1 : 0,
				ref.pending ? 1 : 0,
				ref.packOffset ?? null,
				ref.crc32 ?? null,
				ref.packGeneration ?? null
			]
		);
		if (!this.c.inTx()) await this.c.persist();
		return ref.id;
	}

	async bulkPut(refs: BlobRef[]): Promise<void> {
		if (!refs.length) return;
		if (this.c.inTx()) {
			for (const r of refs) await this.put(r);
			return;
		}
		await this.c.transaction('rw', async () => {
			for (const r of refs) await this.put(r);
		});
	}

	async bulkGet(ids: string[]): Promise<Array<BlobRef | undefined>> {
		return Promise.all(ids.map((id) => this.get(id)));
	}

	async bulkDelete(ids: string[]): Promise<void> {
		for (const id of ids) await this.c.run('DELETE FROM blob_refs WHERE id = ?', [id]);
		if (!this.c.inTx()) await this.c.persist();
	}

	async delete(id: string): Promise<void> {
		await this.c.run('DELETE FROM blob_refs WHERE id = ?', [id]);
		if (!this.c.inTx()) await this.c.persist();
	}

	async toArray(): Promise<BlobRef[]> {
		return (await this.c.exec('SELECT * FROM blob_refs')).map(decodeBlob);
	}

	async clear(): Promise<void> {
		await this.c.run('DELETE FROM blob_refs');
		if (!this.c.inTx()) await this.c.persist();
	}

	async update(id: string, mods: Partial<BlobRef>): Promise<number> {
		const cur = await this.get(id);
		if (!cur) return 0;
		await this.put({ ...cur, ...mods, id });
		return 1;
	}

	where(index: string): {
		equals: (value: unknown) => SqlCollection<BlobRef>;
	} {
		return {
			equals: (value: unknown) => {
				if (index === 'opfsPath') {
					return new SqlCollection(async () =>
						(await this.c.exec('SELECT * FROM blob_refs WHERE opfs_path = ?', [value])).map(
							decodeBlob
						)
					);
				}
				if (index === 'id') {
					return new SqlCollection(async () =>
						(await this.c.exec('SELECT * FROM blob_refs WHERE id = ?', [value])).map(decodeBlob)
					);
				}
				return new SqlCollection(async () => []);
			}
		};
	}
}

class DraftTable {
	private readonly c: SqliteCatalog;
	constructor(c: SqliteCatalog) {
		this.c = c;
	}

	async get(id: string): Promise<AppDraft | undefined> {
		const rows = await this.c.exec('SELECT * FROM drafts WHERE id = ?', [id]);
		return rows[0] ? decodeDraft(rows[0]) : undefined;
	}

	async put(draft: AppDraft): Promise<string> {
		await this.c.run(
			`INSERT INTO drafts (id, app_id, updated_at, payload, open_file_id, open_file_generation)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         app_id=excluded.app_id, updated_at=excluded.updated_at, payload=excluded.payload,
         open_file_id=excluded.open_file_id, open_file_generation=excluded.open_file_generation`,
			[
				draft.id,
				draft.appId,
				draft.updatedAt,
				jsonOrNull(draft.payload),
				draft.openFileId ?? null,
				draft.openFileGeneration ?? null
			]
		);
		if (!this.c.inTx()) await this.c.persist();
		return draft.id;
	}

	async delete(id: string): Promise<void> {
		await this.c.run('DELETE FROM drafts WHERE id = ?', [id]);
		if (!this.c.inTx()) await this.c.persist();
	}

	async clear(): Promise<void> {
		await this.c.run('DELETE FROM drafts');
		if (!this.c.inTx()) await this.c.persist();
	}

	async toArray(): Promise<AppDraft[]> {
		return (await this.c.exec('SELECT * FROM drafts')).map(decodeDraft);
	}
}

class MetaTable {
	private readonly c: SqliteCatalog;
	constructor(c: SqliteCatalog) {
		this.c = c;
	}

	async get(key: string): Promise<MetaRow | undefined> {
		const rows = await this.c.exec('SELECT key, value FROM kv WHERE key = ?', [key]);
		if (!rows[0]) return undefined;
		return { key: String(rows[0].key), value: parseJson(rows[0].value, rows[0].value) };
	}

	async put(row: MetaRow): Promise<string> {
		await this.c.run(
			`INSERT INTO kv (key, value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
			[row.key, jsonOrNull(row.value)]
		);
		if (!this.c.inTx()) await this.c.persist();
		return row.key;
	}

	async clear(): Promise<void> {
		await this.c.run('DELETE FROM kv');
		if (!this.c.inTx()) await this.c.persist();
	}

	async toArray(): Promise<MetaRow[]> {
		return (await this.c.exec('SELECT key, value FROM kv')).map((r) => ({
			key: String(r.key),
			value: parseJson(r.value, r.value)
		}));
	}
}

class LeaseTable {
	private readonly c: SqliteCatalog;
	constructor(c: SqliteCatalog) {
		this.c = c;
	}

	async get(key: string): Promise<LeaseRow | undefined> {
		const rows = await this.c.exec('SELECT key, owner, expires_at FROM leases WHERE key = ?', [key]);
		if (!rows[0]) return undefined;
		return {
			key: String(rows[0].key),
			owner: String(rows[0].owner),
			expiresAt: Number(rows[0].expires_at)
		};
	}

	async put(row: LeaseRow): Promise<string> {
		await this.c.run(
			`INSERT INTO leases (key, owner, expires_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at`,
			[row.key, row.owner, row.expiresAt]
		);
		if (!this.c.inTx()) await this.c.persist();
		return row.key;
	}

	async bulkPut(rows: LeaseRow[]): Promise<void> {
		for (const r of rows) await this.put(r);
	}

	async bulkDelete(keys: string[]): Promise<void> {
		for (const k of keys) await this.c.run('DELETE FROM leases WHERE key = ?', [k]);
		if (!this.c.inTx()) await this.c.persist();
	}

	async delete(key: string): Promise<void> {
		await this.c.run('DELETE FROM leases WHERE key = ?', [key]);
		if (!this.c.inTx()) await this.c.persist();
	}

	async toArray(): Promise<LeaseRow[]> {
		return (await this.c.exec('SELECT key, owner, expires_at FROM leases')).map((r) => ({
			key: String(r.key),
			owner: String(r.owner),
			expiresAt: Number(r.expires_at)
		}));
	}

	async clear(): Promise<void> {
		await this.c.run('DELETE FROM leases');
		if (!this.c.inTx()) await this.c.persist();
	}
}
