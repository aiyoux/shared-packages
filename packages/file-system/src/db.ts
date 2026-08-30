import Dexie, { type Table } from 'dexie';
import type { AppDraft, BlobRef, VfsNode } from './types.js';

/**
 * Stand-in key for "no parent". A string, because IndexedDB will not index
 * null; chosen to be something a real node id can never collide with.
 */
export const ROOT_PARENT_KEY = '\u0000root';

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

		// v5: `parentKey` — an indexable stand-in for parentId.
		//
		// IndexedDB cannot index `null`, so listing the root fell back to a full
		// table scan and filter (34.89ms for 800 root children, against ~1ms for
		// an index hit). parentKey is parentId for a child and a sentinel for a
		// root node, so both cases are one indexed lookup.
		this.version(5)
			.stores({
				nodes:
					'id, parentId, parentKey, kind, fileType, name, updatedAt, deletedAt, ' +
					'[parentId+name], [parentId+deletedAt], [parentId+sortOrder]',
				blobRefs: 'id, opfsPath, createdAt',
				drafts: 'id, appId, updatedAt',
				meta: 'key',
				leases: 'key, expiresAt'
			})
			.upgrade(async (tx) => {
				// Existing rows have no parentKey and would be invisible to a
				// parentKey lookup — which reads as vanished files, so this must
				// backfill every row rather than only the roots.
				await tx
					.table('nodes')
					.toCollection()
					.modify((n: VfsNode) => {
						(n as VfsNode & { parentKey?: string }).parentKey = n.parentId ?? ROOT_PARENT_KEY;
					});
			});

		// v6 adds [parentKey+name]. v5 gave root LISTING an index but left
		// single-name LOOKUP scanning: [parentId+name] cannot serve the root
		// (null is not an IndexedDB key), so every "does this folder contain
		// X?" walked the siblings. Path resolution does that once per segment,
		// which made git-on-VFS O(N^2) in directory entries scanned — measured
		// at 427 entries/file for a 30-file commit and 1182/file at 120.
		// Index only; parentKey was already backfilled by v5, so no data
		// migration is needed here.
		this.version(6).stores({
			nodes:
				'id, parentId, parentKey, kind, fileType, name, updatedAt, deletedAt, ' +
				'[parentId+name], [parentKey+name], [parentId+deletedAt], [parentId+sortOrder]',
			blobRefs: 'id, opfsPath, createdAt',
			drafts: 'id, appId, updatedAt',
			meta: 'key',
			leases: 'key, expiresAt'
		});

		// Derive parentKey here rather than at each call site. Node writes happen
		// in many places (mkdir, writeFile, writeFiles, move, restore, copy,
		// migration), and one that forgot to set it would silently drop those
		// nodes out of root listings — indistinguishable from data loss. A hook
		// cannot be forgotten, and covers call sites not yet written.
		this.nodes.hook('creating', (_pk, obj) => {
			(obj as VfsNode & { parentKey?: string }).parentKey = obj.parentId ?? ROOT_PARENT_KEY;
		});
		this.nodes.hook('updating', (mods, _pk, obj) => {
			if (!('parentId' in (mods as Record<string, unknown>))) return;
			const next = (mods as { parentId?: string | null }).parentId ?? null;
			const key = next ?? ROOT_PARENT_KEY;
			const current = (obj as VfsNode & { parentKey?: string }).parentKey;
			return key === current ? undefined : { parentKey: key };
		});
	}
}
