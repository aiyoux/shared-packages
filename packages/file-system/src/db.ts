import Dexie, { type Table } from 'dexie';
import type { AppDraft, BlobRef, VfsNode } from './types.js';

export type MetaRow = { key: string; value: unknown };
export type LeaseRow = { key: string; owner: string; expiresAt: number };

export class SharedVfsDatabase extends Dexie {
	nodes!: Table<VfsNode, string>;
	blobRefs!: Table<BlobRef, string>;
	drafts!: Table<AppDraft, string>;
	meta!: Table<MetaRow, string>;
	leases!: Table<LeaseRow, string>;

	constructor(name = 'SharedVFS') {
		super(name);
		this.version(1).stores({
			nodes:
				'id, parentId, kind, fileType, name, updatedAt, deletedAt, [parentId+name], [parentId+deletedAt]',
			blobRefs: 'id, opfsPath, createdAt',
			drafts: 'id, appId, updatedAt',
			meta: 'key',
			leases: 'key, expiresAt'
		});
		// v2: sibling sortOrder field (no new index required). Backfill active siblings.
		this.version(2)
			.stores({
				nodes:
					'id, parentId, kind, fileType, name, updatedAt, deletedAt, [parentId+name], [parentId+deletedAt]',
				blobRefs: 'id, opfsPath, createdAt',
				drafts: 'id, appId, updatedAt',
				meta: 'key',
				leases: 'key, expiresAt'
			})
			.upgrade(async (tx) => {
				const table = tx.table('nodes');
				const all = (await table.toArray()) as Array<{
					id: string;
					parentId: string | null;
					kind: string;
					name: string;
					deletedAt?: number | null;
					sortOrder?: number;
				}>;
				const active = all.filter((n) => n.deletedAt == null);
				const groups = new Map<string, typeof active>();
				for (const n of active) {
					const key = n.parentId ?? '__root__';
					const g = groups.get(key) ?? [];
					g.push(n);
					groups.set(key, g);
				}
				const STEP = 16384;
				for (const g of groups.values()) {
					g.sort((a, b) => {
						if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
						return a.name.localeCompare(b.name);
					});
					for (let i = 0; i < g.length; i++) {
						await table.update(g[i]!.id, { sortOrder: i * STEP });
					}
				}
			});
		// v3: compound sortOrder index so nextAppendSortOrder can read the last
		// sibling without loading and sorting the whole folder (extracting
		// thousands of files was quadratic).
		this.version(3).stores({
			nodes:
				'id, parentId, kind, fileType, name, updatedAt, deletedAt, [parentId+name], [parentId+deletedAt], [parentId+sortOrder]',
			blobRefs: 'id, opfsPath, createdAt',
			drafts: 'id, appId, updatedAt',
			meta: 'key',
			leases: 'key, expiresAt'
		});
		// v4: packed blobs. Several members can share one OPFS file, so
		// releasing storage must ask "does any ref still name this path?" —
		// `opfsPath` was already indexed, which makes that a lookup. Pure index
		// metadata: no upgrade body, existing rows keep no packOffset and take
		// the standalone path unchanged.
		this.version(4).stores({
			nodes:
				'id, parentId, kind, fileType, name, updatedAt, deletedAt, [parentId+name], [parentId+deletedAt], [parentId+sortOrder]',
			blobRefs: 'id, opfsPath, createdAt',
			drafts: 'id, appId, updatedAt',
			meta: 'key',
			leases: 'key, expiresAt'
		});
	}
}
