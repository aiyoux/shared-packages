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
 */
export async function buildStorageTree(
	vfs: VfsService,
	parentId: string | null,
	opts?: { maxDepth?: number }
): Promise<TreemapInput[]> {
	const maxDepth = opts?.maxDepth ?? 3;

	const walk = async (id: string | null, depth: number): Promise<TreemapInput[]> => {
		const nodes = await vfs.list({ parentId: id });
		const out: TreemapInput[] = [];
		for (const node of nodes) {
			if (node.kind === 'folder') {
				const children = depth < maxDepth ? await walk(node.id, depth + 1) : [];
				// Even when we stop descending, the folder's size must reflect
				// everything under it or the map lies about what it holds.
				const size = children.length
					? children.reduce((n, c) => n + c.size, 0)
					: await subtreeBytes(vfs, node.id);
				const isProject = Boolean(node.meta?.[PROJECT_PACK_META]);
				// Roll packed bytes up. A folder is what actually gets drawn once
				// the map stops descending, so if it does not carry this, packed
				// storage is invisible on exactly the deep trees that have most
				// of it.
				const packedBytes = children.length
					? children.reduce((n, c) => n + (c.packedBytes ?? 0), 0)
					: await subtreePackedBytes(vfs, node.id);
				out.push({
					id: node.id,
					name: node.name,
					size,
					kind: 'folder',
					group: isProject ? 'project' : 'plain',
					packedBytes,
					children
				});
				continue;
			}
			const ref = node.blobId ? await vfs.db.blobRefs.get(node.blobId) : undefined;
			out.push({
				id: node.id,
				name: node.name,
				size: node.size ?? ref?.byteLength ?? 0,
				kind: 'file',
				group: ref?.packOffset != null ? 'pack' : 'plain',
				packedBytes: ref?.packOffset != null ? (ref.byteLength ?? 0) : 0
			});
		}
		return out;
	};

	return walk(parentId, 1);
}

/** Packed bytes under a folder, for subtrees the map does not descend into. */
async function subtreePackedBytes(vfs: VfsService, rootId: string): Promise<number> {
	let total = 0;
	const stack = [rootId];
	while (stack.length) {
		for (const n of await vfs.list({ parentId: stack.pop()! })) {
			if (n.kind === 'folder') {
				stack.push(n.id);
				continue;
			}
			if (!n.blobId) continue;
			const ref = await vfs.db.blobRefs.get(n.blobId);
			if (ref?.packOffset != null) total += ref.byteLength;
		}
	}
	return total;
}

/** Total live bytes under a folder, without building the whole tree. */
export async function subtreeBytes(vfs: VfsService, parentId: string | null): Promise<number> {
	let total = 0;
	const stack: Array<string | null> = [parentId];
	while (stack.length) {
		const id = stack.pop()!;
		for (const node of await vfs.list({ parentId: id })) {
			if (node.kind === 'folder') stack.push(node.id);
			else total += node.size ?? 0;
		}
	}
	return total;
}
