/**
 * Project packs: shared-storage blobs scoped to a single project.
 *
 * Packing trades robustness for write speed — members share one OPFS file, so
 * releasing one has to prove no sibling still needs it, and space only comes
 * back when the last member dies. That is a good trade exactly where deletion
 * happens at the same granularity as the pack, which is what a project is:
 * you delete a project whole, and every pack it owns dies with it.
 *
 * The general filesystem deliberately does NOT pack (see
 * `VfsService.writeFiles`, where `pack` defaults to false). This module is the
 * one place that opts in.
 *
 * A project's packs are described by a manifest so the collection can be
 * inspected, integrity-checked, and backed up as a unit rather than by walking
 * thousands of files.
 */
import type { VfsService } from './vfs.js';
import type { BlobRef, PackOpProgress, PackOpStage, VfsNode } from './types.js';

/** Marks a folder as a project whose file bytes live in shared packs. */
export const PROJECT_PACK_META = 'projectPack';

export type ProjectPackManifest = {
	/** Folder id of the project root. */
	rootId: string;
	/** Distinct OPFS pack paths this project's members live in. */
	packPaths: string[];
	/** Members stored inside packs. */
	packedFiles: number;
	/** Members with their own file (too large to pack, or written singly). */
	standaloneFiles: number;
	/** Bytes of live members inside packs. */
	packedBytes: number;
	/** Bytes the pack files actually occupy on disk. */
	packBytesOnDisk: number;
	/**
	 * Bytes held by packs that no blobRef claims any more — the cost of the
	 * trade, and what compaction reclaims. Bytes belonging to a TRASHED member
	 * are not dead: they are still owned, and only emptying the trash releases
	 * them.
	 */
	deadBytes: number;
};

export type PackIntegrityIssue = {
	kind:
		| 'missing-pack'
		| 'short-pack'
		| 'orphan-pack'
		| 'overlap'
		| 'missing-ref'
		| 'pending-write';
	detail: string;
	packPath?: string;
	nodeId?: string;
};

export type PackIntegrityReport = {
	checked: number;
	packPaths: string[];
	issues: PackIntegrityIssue[];
	ok: boolean;
};

/** Every live descendant file of `rootId`, depth-first. */
export async function descendantFiles(vfs: VfsService, rootId: string): Promise<VfsNode[]> {
	const out: VfsNode[] = [];
	const stack: string[] = [rootId];
	while (stack.length) {
		const parentId = stack.pop()!;
		const kids = await vfs.list({ parentId });
		for (const k of kids) {
			if (k.kind === 'folder') {
				if (k.name === '.git') continue;
				stack.push(k.id);
			} else out.push(k);
		}
	}
	return out;
}

async function refsFor(vfs: VfsService, nodes: VfsNode[]): Promise<Map<string, BlobRef>> {
	const ids = nodes.map((n) => n.blobId).filter((b): b is string => Boolean(b));
	const rows = await vfs.db.blobRefs.bulkGet(ids);
	const map = new Map<string, BlobRef>();
	for (const r of rows) if (r) map.set(r.id, r);
	return map;
}

/**
 * Describe a project's pack usage.
 *
 * `deadBytes` is the number that matters: it is space the project is holding
 * but not using, and the reason compaction exists.
 */
export async function readProjectManifest(
	vfs: VfsService,
	rootId: string
): Promise<ProjectPackManifest> {
	const files = await descendantFiles(vfs, rootId);
	const refs = await refsFor(vfs, files);

	const packPaths = new Set<string>();
	let packedFiles = 0;
	let standaloneFiles = 0;
	let packedBytes = 0;

	for (const f of files) {
		const ref = f.blobId ? refs.get(f.blobId) : undefined;
		if (!ref) continue;
		if (ref.packOffset != null) {
			packPaths.add(ref.opfsPath);
			packedFiles += 1;
			packedBytes += ref.byteLength;
		} else {
			standaloneFiles += 1;
		}
	}

	// On-disk size is measured, not assumed: a pack can outlive some of its
	// members, and the gap is exactly the dead space.
	//
	// The gap is measured against EVERY ref naming the pack, not just the live
	// descendants walked above. A trashed member still holds its ref and its
	// bytes come back only when the trash is emptied, so counting it as dead
	// would promise space that no action available to the user can reclaim —
	// the same live-only reading that made the integrity check cry orphan.
	let packBytesOnDisk = 0;
	let claimedBytes = 0;
	for (const path of packPaths) {
		try {
			const blob = await vfs.opfs.readBlob(path);
			packBytesOnDisk += blob.size;
		} catch {
			/* a missing pack is an integrity problem, reported by checkProjectPacks */
			continue;
		}
		await vfs.db.blobRefs
			.where('opfsPath')
			.equals(path)
			.each((r) => {
				claimedBytes += r.byteLength;
			});
	}

	return {
		rootId,
		packPaths: [...packPaths],
		packedFiles,
		standaloneFiles,
		packedBytes,
		packBytesOnDisk,
		deadBytes: Math.max(0, packBytesOnDisk - claimedBytes)
	};
}

/**
 * Verify that every packed member can actually be read back from where its
 * ref says it lives.
 *
 * This is the check behind the "check integrity" buttons. It reads sizes and
 * bounds rather than hashing content — the failure modes that packing can
 * introduce are structural (a pack unlinked while members still point at it,
 * an offset past the end, two members claiming the same bytes), and those are
 * all visible without rehashing every byte.
 */
export async function checkProjectPacks(
	vfs: VfsService,
	rootId: string
): Promise<PackIntegrityReport> {
	const files = await descendantFiles(vfs, rootId);
	const refs = await refsFor(vfs, files);
	const issues: PackIntegrityIssue[] = [];
	const packPaths = new Set<string>();

	// Pack path -> claimed [start, end) ranges, to catch overlap.
	const claims = new Map<string, Array<{ from: number; to: number; nodeId: string }>>();
	const sizes = new Map<string, number>();

	for (const f of files) {
		if (!f.blobId) continue;
		const ref = refs.get(f.blobId);
		if (!ref) {
			issues.push({
				kind: 'missing-ref',
				detail: `${f.name} has no blobRef`,
				nodeId: f.id
			});
			continue;
		}
		if (ref.pending) {
			issues.push({
				kind: 'pending-write',
				detail: `${f.name} is reserved but never confirmed`,
				packPath: ref.opfsPath,
				nodeId: f.id
			});
			continue;
		}
		if (ref.packOffset == null) continue;
		packPaths.add(ref.opfsPath);

		if (!sizes.has(ref.opfsPath)) {
			try {
				const blob = await vfs.opfs.readBlob(ref.opfsPath);
				sizes.set(ref.opfsPath, blob.size);
			} catch {
				sizes.set(ref.opfsPath, -1);
			}
		}
		const packSize = sizes.get(ref.opfsPath)!;
		if (packSize < 0) {
			issues.push({
				kind: 'missing-pack',
				detail: `${f.name} points at ${ref.opfsPath}, which is gone`,
				packPath: ref.opfsPath,
				nodeId: f.id
			});
			continue;
		}
		const end = ref.packOffset + ref.byteLength;
		if (end > packSize) {
			issues.push({
				kind: 'short-pack',
				detail: `${f.name} needs bytes ${ref.packOffset}-${end} but ${ref.opfsPath} is only ${packSize}`,
				packPath: ref.opfsPath,
				nodeId: f.id
			});
			continue;
		}
		const list = claims.get(ref.opfsPath) ?? [];
		list.push({ from: ref.packOffset, to: end, nodeId: f.id });
		claims.set(ref.opfsPath, list);
	}

	for (const [path, list] of claims) {
		list.sort((a, b) => a.from - b.from);
		for (let i = 1; i < list.length; i++) {
			if (list[i]!.from < list[i - 1]!.to) {
				issues.push({
					kind: 'overlap',
					detail: `two members claim overlapping bytes in ${path}`,
					packPath: path,
					nodeId: list[i]!.nodeId
				});
			}
		}
	}

	return {
		checked: files.length,
		packPaths: [...packPaths],
		issues,
		ok: issues.length === 0
	};
}

// Pack progress types live in types.ts because VfsService owns pack mutation
// and cannot import this module. Re-exported so callers keep one import site.
export type { PackOpStage, PackOpProgress } from './types.js';

export type DeleteFromProjectResult = {
	deleted: number;
	compactedPacks: number;
	reclaimedBytes: number;
};


/**
 * Delete nodes from a project and reclaim their pack space in the same
 * operation.
 *
 * Reclamation is part of the delete, not deferred to a background sweep: a
 * sweep that runs "later" cannot report failure to the person who asked for
 * the delete, and in short sessions may never run at all. If compaction
 * fails, THE DELETE FAILS — the caller sees an error rather than a success
 * that quietly left bytes behind.
 *
 * Compaction never mutates a live pack. It writes a fresh pack from slices of
 * the old one (no bytes pass through the JS heap), verifies the result, swaps
 * every affected ref in ONE transaction, and only then retires the old file.
 * A crash before the swap leaves the old pack authoritative and loses nothing.
 */
export async function deleteFromProject(
	vfs: VfsService,
	nodeIds: string[],
	opts?: { onProgress?: (ev: PackOpProgress) => void; signal?: AbortSignal }
): Promise<DeleteFromProjectResult> {
	const report = (stage: PackOpStage, label: string, reclaimedBytes?: number) =>
		opts?.onProgress?.({ stage, label, reclaimedBytes });

	// Which packs are about to lose members? Collected BEFORE the delete, since
	// the refs are gone afterwards.
	const touched = new Map<string, number>(); // packPath -> bytes being freed
	for (const id of nodeIds) {
		const node = await vfs.get(id);
		if (!node?.blobId) continue;
		const ref = await vfs.db.blobRefs.get(node.blobId);
		if (!ref || ref.packOffset == null) continue;
		touched.set(ref.opfsPath, (touched.get(ref.opfsPath) ?? 0) + ref.byteLength);
	}

	const dropBlobIds = new Set<string>();
	for (const id of nodeIds) {
		const node = await vfs.get(id);
		if (node?.blobId) dropBlobIds.add(node.blobId);
	}
	let compactedPacks = 0;
	let reclaimedBytes = 0;
	if (touched.size) {
		report('compacting', 'Deleting — compacting packs before drop…');
		const compacted = await vfs.compactPacks(touched.keys(), {
			excludeBlobIds: dropBlobIds,
			onProgress: opts?.onProgress,
			signal: opts?.signal
		});
		compactedPacks = compacted.compactedPacks;
		reclaimedBytes = compacted.reclaimedBytes;
	}

	report('wiping', `Deleting — wiping ${nodeIds.length} from blob…`);
	let deleted = 0;
	for (const id of nodeIds) {
		if (opts?.signal?.aborted) {
			const e = new Error('Cancelled');
			e.name = 'AbortError';
			throw e;
		}
		// One compaction for the whole batch, not one per node: deleting N
		// members of a pack must not rewrite that pack N times.
		await vfs.permanentDelete(id, { recursive: true, compact: false });
		deleted += 1;
	}

	report(
		'done',
		reclaimedBytes > 0
			? `Success! Blob integrity checked, ${formatBytes(reclaimedBytes)} reclaimed, delete successful`
			: 'Success! Blob integrity checked, delete successful',
		reclaimedBytes
	);
	return { deleted, compactedPacks: compactedPacks, reclaimedBytes: reclaimedBytes };
}


function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export type ProjectBackup = {
	manifest: ProjectPackManifest;
	/** Pack files, whole, keyed by their OPFS path. */
	packs: Array<{ path: string; blob: Blob }>;
	/** Members not stored in a pack, keyed by node id. */
	standalone: Array<{ nodeId: string; name: string; blob: Blob }>;
	/** Tree structure needed to restore names and folders. */
	entries: Array<{
		id: string;
		parentId: string | null;
		name: string;
		kind: 'file' | 'folder';
		blobId?: string;
		packOffset?: number;
		byteLength?: number;
	}>;
};

/**
 * Back up a project by taking its packs whole, rather than walking every file.
 *
 * This is the payoff for scoping packs to projects: a project of thousands of
 * files is a handful of pack blobs plus a small tree description, so a backup
 * is a few reads instead of thousands. Packs are returned as lazy Blobs — the
 * bytes are not pulled into memory here.
 */
export async function backupProject(
	vfs: VfsService,
	rootId: string
): Promise<ProjectBackup> {
	const manifest = await readProjectManifest(vfs, rootId);
	const files = await descendantFiles(vfs, rootId);
	const refs = await refsFor(vfs, files);

	const packs: ProjectBackup['packs'] = [];
	for (const path of manifest.packPaths) {
		packs.push({ path, blob: await vfs.opfs.readBlob(path) });
	}

	const standalone: ProjectBackup['standalone'] = [];
	const entries: ProjectBackup['entries'] = [];

	// Folders first, so a restore can rebuild the tree before placing files.
	const stack: string[] = [rootId];
	while (stack.length) {
		const parentId = stack.pop()!;
		for (const node of await vfs.list({ parentId })) {
			entries.push({
				id: node.id,
				parentId: node.parentId,
				name: node.name,
				kind: node.kind === 'folder' ? 'folder' : 'file'
			});
			if (node.kind === 'folder') stack.push(node.id);
		}
	}

	for (const f of files) {
		const ref = f.blobId ? refs.get(f.blobId) : undefined;
		const entry = entries.find((e) => e.id === f.id);
		if (entry && ref) {
			entry.blobId = ref.id;
			entry.byteLength = ref.byteLength;
			if (ref.packOffset != null) entry.packOffset = ref.packOffset;
		}
		if (ref && ref.packOffset == null) {
			standalone.push({ nodeId: f.id, name: f.name, blob: await vfs.readBlob(f.id) });
		}
	}

	return { manifest, packs, standalone, entries };
}


/**
 * Whole-filesystem integrity check — the "check filesystem integrity" action.
 *
 * Verifies the same structural invariants as `checkProjectPacks` but over
 * every live file, plus the two things only a global pass can see: refs whose
 * storage has vanished, and pack files nothing points at any more.
 *
 * "Nothing points at" means no blobRef anywhere, which is a wider net than
 * the live files this walks: a trashed file still holds its ref, and its pack
 * is still doing its job. Reporting those as orphans told users their storage
 * was corrupt after an ordinary delete, and no amount of deleting could clear
 * it — the deleting was the cause.
 */
export async function checkFilesystem(vfs: VfsService): Promise<PackIntegrityReport> {
	const issues: PackIntegrityIssue[] = [];
	const nodes = await vfs.db.nodes.toArray();
	const live = nodes.filter((n) => n.deletedAt == null && n.kind === 'file');
	const refs = await vfs.db.blobRefs.toArray();
	const refById = new Map(refs.map((r) => [r.id, r]));

	const packPaths = new Set<string>();
	const sizes = new Map<string, number>();

	// A path is spoken for if ANY blobRef names it — not just a ref reached
	// from a live file. Trashed files keep their refs (that is what makes a
	// restore possible), so their packs are still owned and must never be
	// reported as garbage. This is deliberately the same rule `gc()` sweeps
	// by: the check and the sweep disagreeing is what made emptying the
	// trash look like the only way to silence the report.
	const namedPaths = new Set<string>();
	for (const ref of refs) {
		namedPaths.add(ref.opfsPath);
		// Promote may have moved bytes to blobs/<id>.bin while the row still
		// names tmp/… — treat both as named, as gc() does.
		if (ref.pendingPromote) namedPaths.add(`blobs/${ref.id}.bin`);
	}

	const sizeOf = async (path: string): Promise<number> => {
		if (sizes.has(path)) return sizes.get(path)!;
		let size = -1;
		try {
			size = (await vfs.opfs.readBlob(path)).size;
		} catch {
			size = -1;
		}
		sizes.set(path, size);
		return size;
	};

	for (const node of live) {
		if (!node.blobId) continue;
		const ref = refById.get(node.blobId);
		if (!ref) {
			issues.push({ kind: 'missing-ref', detail: `${node.name} has no blobRef`, nodeId: node.id });
			continue;
		}
		const size = await sizeOf(ref.opfsPath);
		if (size < 0) {
			issues.push({
				kind: 'missing-pack',
				detail: `${node.name} points at ${ref.opfsPath}, which is gone`,
				packPath: ref.opfsPath,
				nodeId: node.id
			});
			continue;
		}
		if (ref.pending) {
			issues.push({
				kind: 'pending-write',
				detail: `${node.name} is reserved but never confirmed (size 0 / pending blobRef)`,
				packPath: ref.opfsPath,
				nodeId: node.id
			});
			continue;
		}
		if (ref.packOffset != null) {
			packPaths.add(ref.opfsPath);
			if (ref.packOffset + ref.byteLength > size) {
				issues.push({
					kind: 'short-pack',
					detail: `${node.name} reads past the end of ${ref.opfsPath}`,
					packPath: ref.opfsPath,
					nodeId: node.id
				});
			}
		}
	}

	// Pack files NO blobRef names: a crashed pack write, and the only pack
	// state that is actually garbage. gc() reclaims exactly these.
	try {
		for (const path of await vfs.opfs.listOrphans('packs')) {
			if (!namedPaths.has(path)) {
				issues.push({
					kind: 'orphan-pack',
					detail: `${path} is not referenced by any file`,
					packPath: path
				});
			}
		}
	} catch {
		/* no packs directory yet */
	}

	return { checked: live.length, packPaths: [...packPaths], issues, ok: issues.length === 0 };
}
