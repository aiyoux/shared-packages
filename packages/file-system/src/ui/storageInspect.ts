/**
 * Build storage-inspector input from a VFS subtree, and answer "is this file
 * packed?" for listing rows.
 *
 * Kept separate from the component so both the file manager and the Projects
 * app feed the same shapes, and so the logic is testable without a DOM.
 */
import type { VfsService } from '../vfs.js';
import type { TreemapInput } from './sizeTreemap.js';
import { PROJECT_PACK_META } from '../projectPack.js';

export type PackBadge = {
	/** This file's bytes live inside a shared pack. */
	packed: boolean;
	/** Which pack, when packed — the unit that has to empty before space returns. */
	packPath?: string;
};

/** Pack membership for a set of nodes, in one pass. */
export async function packBadges(
	vfs: VfsService,
	nodeIds: string[]
): Promise<Map<string, PackBadge>> {
	const out = new Map<string, PackBadge>();
	if (!nodeIds.length) return out;
	const nodes = await vfs.db.nodes.bulkGet(nodeIds);
	const blobIds = nodes.map((n) => n?.blobId).filter((b): b is string => Boolean(b));
	const refs = await vfs.db.blobRefs.bulkGet(blobIds);
	const byId = new Map(refs.filter(Boolean).map((r) => [r!.id, r!]));
	for (const node of nodes) {
		if (!node) continue;
		const ref = node.blobId ? byId.get(node.blobId) : undefined;
		out.set(
			node.id,
			ref?.packOffset != null
				? { packed: true, packPath: ref.opfsPath }
				: { packed: false }
		);
	}
	return out;
}

/**
 * Map a folder into treemap input.
 *
 * Folder sizes are the sum of their descendants, so a folder's rectangle
 * genuinely represents what deleting it would free. Nodes are tagged
 * `project` or `pack` so the inspector can outline them differently — those
 * two behave differently on delete, and the picture should say so.
 *
 * One catalog join (nodes ⟕ blob_refs) plus an in-memory rollup. The SQLite
 * catalog cannot afford a list()+blobRefs.get() per row the way Dexie did.
 */
export async function buildStorageTree(
	vfs: VfsService,
	parentId: string | null,
	opts?: { maxDepth?: number }
): Promise<TreemapInput[]> {
	const maxDepth = opts?.maxDepth ?? 3;
	const rows = await vfs.db.liveStorageRows(parentId);
	const byParent = new Map<string | null, typeof rows>();
	for (const row of rows) {
		const list = byParent.get(row.parentId);
		if (list) list.push(row);
		else byParent.set(row.parentId, [row]);
	}

	const sizeMemo = new Map<string, { size: number; packed: number }>();
	const rollup = (id: string): { size: number; packed: number } => {
		const hit = sizeMemo.get(id);
		if (hit) return hit;
		let size = 0;
		let packed = 0;
		for (const child of byParent.get(id) ?? []) {
			if (child.kind === 'folder') {
				const sub = rollup(child.id);
				size += sub.size;
				packed += sub.packed;
			} else {
				const bytes = child.size || child.byteLength;
				size += bytes;
				if (child.packOffset != null) packed += child.byteLength || bytes;
			}
		}
		const next = { size, packed };
		sizeMemo.set(id, next);
		return next;
	};

	const toInput = (row: (typeof rows)[number], depth: number): TreemapInput => {
		if (row.kind === 'folder') {
			const kids = byParent.get(row.id) ?? [];
			const children = depth < maxDepth ? kids.map((c) => toInput(c, depth + 1)) : [];
			const { size, packed } = rollup(row.id);
			return {
				id: row.id,
				name: row.name,
				size,
				kind: 'folder',
				group: Boolean(row.meta?.[PROJECT_PACK_META]) ? 'project' : 'plain',
				packedBytes: packed,
				children
			};
		}
		const bytes = row.size || row.byteLength;
		return {
			id: row.id,
			name: row.name,
			size: bytes,
			kind: 'file',
			group: row.packOffset != null ? 'pack' : 'plain',
			packedBytes: row.packOffset != null ? row.byteLength || bytes : 0
		};
	};

	return (byParent.get(parentId) ?? []).map((row) => toInput(row, 1));
}

/** Total live bytes under a folder, without building the whole tree. */
export async function subtreeBytes(vfs: VfsService, parentId: string | null): Promise<number> {
	const rows = await vfs.db.liveStorageRows(parentId);
	let total = 0;
	for (const row of rows) {
		if (row.kind === 'file') total += row.size || row.byteLength;
	}
	return total;
}
