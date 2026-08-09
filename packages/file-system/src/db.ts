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
	}
}
