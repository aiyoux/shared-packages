/**
 * Exporting and importing a project.
 *
 * Two shapes, for two different jobs:
 *
 *  - **files** — an ordinary ZIP of the tree. Anything can open it. This is
 *    the one to hand someone else.
 *  - **bundle** (`.sprj`) — the packs taken whole plus a manifest. Fast, exact,
 *    and only this app can read it. It gets its own extension precisely so
 *    nobody mistakes it for the portable one.
 *
 * The metadata question is what connects them. `.project.json` is a real file
 * in the folder, so a files-export includes it for free — which means
 * "preserve metadata" is really about whether to ALSO record how storage was
 * laid out, so an import can rebuild the same packs. Exported without it, the
 * archive is just files, and importing it gives an ordinary folder that can be
 * initialised as a project later if the user wants.
 *
 * Pack layout is recorded as MEMBERSHIP AND ORDER, never byte offsets. Offsets
 * are meaningless in a pack that has not been written yet and are recomputed
 * on import; membership is the part that reproduces.
 */
import { expandBytes, packFiles, type ArchiveEntry } from '@shared-packages/compress';
import type { VfsService } from './vfs.js';
import type { BlobRef, PackOpProgress, VfsNode } from './types.js';
import { descendantFiles } from './projectPack.js';
import {
	PROJECT_META_FILE,
	readProjectMeta,
	writeProjectMeta,
	type ProjectMeta
} from './projectMeta.js';

/** Sidecar naming which files shared a pack, so an import can rebuild it. */
export const PACK_LAYOUT_FILE = '.project-packs.json';
/** Manifest inside a `.sprj` bundle. */
export const BUNDLE_MANIFEST = 'manifest.json';
export const PROJECT_BUNDLE_EXT = '.sprj';

export type PackLayout = {
	schemaVersion: number;
	/** Each entry is one pack's members, in the order they were stored. */
	packs: string[][];
};

export type ProjectExportMode = 'files' | 'bundle';

export type ProjectExport = {
	name: string;
	bytes: Uint8Array;
	mode: ProjectExportMode;
	files: number;
};

type Report = (ev: PackOpProgress) => void;

function relPathOf(node: VfsNode, byId: Map<string, VfsNode>, rootId: string): string {
	const parts: string[] = [node.name];
	let cur = node.parentId;
	while (cur && cur !== rootId) {
		const p = byId.get(cur);
		if (!p) break;
		parts.unshift(p.name);
		cur = p.parentId;
	}
	return parts.join('/');
}

async function treeIndex(vfs: VfsService, rootId: string): Promise<Map<string, VfsNode>> {
	const byId = new Map<string, VfsNode>();
	const stack = [rootId];
	while (stack.length) {
		for (const n of await vfs.list({ parentId: stack.pop()! })) {
			byId.set(n.id, n);
			if (n.kind === 'folder') stack.push(n.id);
		}
	}
	return byId;
}

/**
 * Export as an ordinary ZIP.
 *
 * `preserveMetadata: false` strips `.project.json` as well, so what comes out
 * really is just a folder of files — importing it later produces a plain
 * folder, exactly as if it had never been a project.
 */
export async function exportProjectAsFiles(
	vfs: VfsService,
	rootId: string,
	opts?: { preserveMetadata?: boolean; signal?: AbortSignal; onProgress?: Report }
): Promise<ProjectExport> {
	const preserve = opts?.preserveMetadata !== false;
	const report: Report = (ev) => opts?.onProgress?.(ev);
	const root = await vfs.get(rootId);
	const byId = await treeIndex(vfs, rootId);
	const files = await descendantFiles(vfs, rootId);

	report({ stage: 'wiping', label: `Reading ${files.length} files…` });
	const entries: ArchiveEntry[] = [];
	const packGroups = new Map<string, string[]>();

	for (const f of files) {
		if (opts?.signal?.aborted) break;
		const path = relPathOf(f, byId, rootId);
		if (path === PROJECT_META_FILE && !preserve) continue;
		entries.push({ name: path, data: await vfs.readBytes(f.id) });

		if (preserve && f.blobId) {
			const ref = await vfs.db.blobRefs.get(f.blobId);
			if (ref?.packOffset != null) {
				const group = packGroups.get(ref.opfsPath) ?? [];
				group.push(path);
				packGroups.set(ref.opfsPath, group);
			}
		}
	}

	if (preserve && packGroups.size) {
		// Membership and order only. An offset from the old pack would be a
		// lie in the new one.
		const layout: PackLayout = { schemaVersion: 1, packs: [...packGroups.values()] };
		entries.push({
			name: PACK_LAYOUT_FILE,
			data: new TextEncoder().encode(`${JSON.stringify(layout, null, 2)}\n`)
		});
	}

	report({ stage: 'verifying', label: 'Building archive…' });
	const packed = await packFiles('fflate', entries, 'zip');
	report({ stage: 'done', label: `Exported ${entries.length} files` });
	return {
		name: `${root?.name ?? 'project'}.zip`,
		bytes: packed[0]!.data,
		mode: 'files',
		files: entries.length
	};
}

/**
 * Export with the packs kept whole.
 *
 * Compaction runs first, deliberately: a pack holding 10MB of live data inside
 * 64MB would otherwise export all 64MB, dead space included.
 */
export async function exportProjectAsBundle(
	vfs: VfsService,
	rootId: string,
	opts?: { signal?: AbortSignal; onProgress?: Report; skipCompaction?: boolean }
): Promise<ProjectExport> {
	const report: Report = (ev) => opts?.onProgress?.(ev);
	const root = await vfs.get(rootId);

	if (!opts?.skipCompaction) {
		report({ stage: 'compacting', label: 'Reclaiming dead space before export…' });
		const files = await descendantFiles(vfs, rootId);
		const paths = new Set<string>();
		for (const f of files) {
			if (!f.blobId) continue;
			const ref = await vfs.db.blobRefs.get(f.blobId);
			if (ref?.packOffset != null) paths.add(ref.opfsPath);
		}
		await vfs.compactPacks(paths, { signal: opts?.signal, onProgress: opts?.onProgress });
	}

	const byId = await treeIndex(vfs, rootId);
	const files = await descendantFiles(vfs, rootId);
	const meta = await readProjectMeta(vfs, rootId);

	const folders = [...byId.values()]
		.filter((n) => n.kind === 'folder')
		.map((n) => relPathOf(n, byId, rootId))
		.sort();

	const entries: ArchiveEntry[] = [];
	const packNames = new Map<string, string>();
	const manifestFiles: Array<{
		path: string;
		size: number;
		pack?: string;
		offset?: number;
		blob?: string;
		contentType?: string;
	}> = [];

	report({ stage: 'wiping', label: 'Collecting packs…' });
	for (const f of files) {
		if (opts?.signal?.aborted) break;
		const path = relPathOf(f, byId, rootId);
		const ref: BlobRef | undefined = f.blobId
			? await vfs.db.blobRefs.get(f.blobId)
			: undefined;
		if (!ref) continue;

		if (ref.packOffset != null) {
			let name = packNames.get(ref.opfsPath);
			if (!name) {
				name = `packs/p${packNames.size}.bin`;
				packNames.set(ref.opfsPath, name);
				const blob = await vfs.opfs.readBlob(ref.opfsPath);
				entries.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
			}
			manifestFiles.push({
				path,
				size: ref.byteLength,
				pack: name,
				offset: ref.packOffset,
				contentType: ref.contentType
			});
		} else {
			const name = `blobs/${manifestFiles.length}.bin`;
			entries.push({ name, data: await vfs.readBytes(f.id) });
			manifestFiles.push({
				path,
				size: ref.byteLength,
				blob: name,
				contentType: ref.contentType
			});
		}
	}

	const manifest = {
		format: 'sprj',
		schemaVersion: 1,
		name: root?.name ?? 'project',
		meta,
		folders,
		files: manifestFiles
	};
	entries.push({
		name: BUNDLE_MANIFEST,
		data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)
	});

	report({ stage: 'verifying', label: 'Building bundle…' });
	const packed = await packFiles('fflate', entries, 'zip');
	report({ stage: 'done', label: `Exported ${manifestFiles.length} files` });
	return {
		name: `${root?.name ?? 'project'}${PROJECT_BUNDLE_EXT}`,
		bytes: packed[0]!.data,
		mode: 'bundle',
		files: manifestFiles.length
	};
}

export type ImportResult = {
	rootId: string;
	files: number;
	meta: ProjectMeta | null;
	mode: ProjectExportMode;
	/** True when packs were rebuilt to match the layout recorded at export. */
	rebuiltAsBefore: boolean;
};

/**
 * Import either shape. The archive says which it is.
 *
 * `rebuildPacks` decides what storage looks like afterwards:
 *   - `as-before` uses the recorded membership, when there is one
 *   - `auto` lets the system pack as it sees fit
 *   - `none` leaves every file in its own blob
 */
export async function importProject(
	vfs: VfsService,
	parentId: string | null,
	archive: Uint8Array,
	opts?: {
		name?: string;
		rebuildPacks?: 'as-before' | 'auto' | 'none';
		signal?: AbortSignal;
		onProgress?: Report;
	}
): Promise<ImportResult> {
	const report: Report = (ev) => opts?.onProgress?.(ev);
	const mode = opts?.rebuildPacks ?? 'as-before';

	report({ stage: 'wiping', label: 'Reading archive…' });
	const members = await expandBytes('fflate', archive, 'zip', 'import.zip', {
		signal: opts?.signal
	});
	const byName = new Map(members.map((m) => [m.name, m.data]));

	const manifestRaw = byName.get(BUNDLE_MANIFEST);
	return manifestRaw
		? importBundle(vfs, parentId, byName, manifestRaw, opts?.name, mode, report)
		: importFiles(vfs, parentId, members, opts?.name, mode, report);
}

async function ensureFolders(
	vfs: VfsService,
	rootId: string,
	paths: string[]
): Promise<Map<string, string>> {
	const dirIds = new Map<string, string>([['', rootId]]);
	for (const path of [...paths].sort()) {
		const parts = path.split('/').filter(Boolean);
		let acc = '';
		let parent = rootId;
		for (const part of parts) {
			const next = acc ? `${acc}/${part}` : part;
			let id = dirIds.get(next);
			if (!id) {
				id = (await vfs.mkdir(parent, part)).id;
				dirIds.set(next, id);
			}
			parent = id;
			acc = next;
		}
	}
	return dirIds;
}

async function importFiles(
	vfs: VfsService,
	parentId: string | null,
	members: ArchiveEntry[],
	nameHint: string | undefined,
	mode: 'as-before' | 'auto' | 'none',
	report: Report
): Promise<ImportResult> {
	const layoutRaw = members.find((m) => m.name === PACK_LAYOUT_FILE);
	const metaRaw = members.find((m) => m.name === PROJECT_META_FILE);
	const meta: ProjectMeta | null = metaRaw
		? (JSON.parse(new TextDecoder().decode(metaRaw.data)) as ProjectMeta)
		: null;

	const root = await vfs.mkdir(parentId, nameHint ?? meta?.name ?? 'Imported project');
	const content = members.filter(
		(m) => m.name !== PACK_LAYOUT_FILE && !m.name.endsWith('/')
	);

	const dirPaths = [
		...new Set(
			content
				.map((m) => m.name.split('/').slice(0, -1).join('/'))
				.filter((d) => d.length > 0)
		)
	];
	const dirIds = await ensureFolders(vfs, root.id, dirPaths);

	report({ stage: 'wiping', label: `Writing ${content.length} files…` });
	const pathToId = new Map<string, string>();
	const inputs = content.map((m) => {
		const dir = m.name.split('/').slice(0, -1).join('/');
		return {
			parentId: dirIds.get(dir) ?? root.id,
			name: m.name.split('/').pop()!,
			body: m.data,
			_path: m.name
		};
	});
	const written = await vfs.writeFiles(
		inputs.map(({ _path: _drop, ...rest }) => rest),
		{ pack: mode === 'auto' }
	);
	written.forEach((n, i) => pathToId.set(inputs[i]!._path, n.id));

	let rebuiltAsBefore = false;
	if (mode === 'as-before' && layoutRaw) {
		const layout = JSON.parse(new TextDecoder().decode(layoutRaw.data)) as PackLayout;
		report({ stage: 'compacting', label: 'Rebuilding packs as they were…' });
		for (const group of layout.packs) {
			const ids = group.map((p) => pathToId.get(p)).filter(Boolean) as string[];
			// Offsets are recomputed; what reproduces is which files share a pack
			// and in what order.
			if (ids.length > 1) await vfs.repackNodes(ids);
		}
		rebuiltAsBefore = true;
	}

	if (meta) {
		await writeProjectMeta(vfs, root.id, {
			...meta,
			updatedAt: new Date().toISOString()
		});
	}
	report({ stage: 'done', label: `Imported ${written.length} files` });
	return {
		rootId: root.id,
		files: written.length,
		meta: await readProjectMeta(vfs, root.id),
		mode: 'files',
		rebuiltAsBefore
	};
}

async function importBundle(
	vfs: VfsService,
	parentId: string | null,
	byName: Map<string, Uint8Array>,
	manifestRaw: Uint8Array,
	nameHint: string | undefined,
	mode: 'as-before' | 'auto' | 'none',
	report: Report
): Promise<ImportResult> {
	const manifest = JSON.parse(new TextDecoder().decode(manifestRaw)) as {
		name?: string;
		meta?: ProjectMeta | null;
		folders?: string[];
		files: Array<{
			path: string;
			size: number;
			pack?: string;
			offset?: number;
			blob?: string;
			contentType?: string;
		}>;
	};

	const root = await vfs.mkdir(parentId, nameHint ?? manifest.name ?? 'Imported project');
	const dirIds = await ensureFolders(vfs, root.id, manifest.folders ?? []);

	// Unpacked import: rebuild through the ordinary write path so the result is
	// an ordinary folder, rather than restoring shared storage the user asked
	// not to have.
	if (mode === 'none' || mode === 'auto') {
		report({ stage: 'wiping', label: `Writing ${manifest.files.length} files…` });
		const inputs = manifest.files.map((f) => {
			const dir = f.path.split('/').slice(0, -1).join('/');
			const src = f.pack
				? byName.get(f.pack)!.subarray(f.offset ?? 0, (f.offset ?? 0) + f.size)
				: byName.get(f.blob!)!;
			return {
				parentId: dirIds.get(dir) ?? root.id,
				name: f.path.split('/').pop()!,
				body: new Uint8Array(src),
				contentType: f.contentType
			};
		});
		const written = await vfs.writeFiles(inputs, { pack: mode === 'auto' });
		report({ stage: 'done', label: `Imported ${written.length} files` });
		return {
			rootId: root.id,
			files: written.length,
			meta: await readProjectMeta(vfs, root.id),
			mode: 'bundle',
			rebuiltAsBefore: false
		};
	}

	// Packs restored whole — the reason this format exists. Each pack is one
	// write, however many files it holds.
	report({ stage: 'wiping', label: 'Restoring packs…' });
	const packMembers = new Map<
		string,
		Array<{ blobId: string; offset: number; byteLength: number; contentType?: string }>
	>();
	const nodesToPut: VfsNode[] = [];
	const now = Date.now();
	let seq = 0;

	for (const f of manifest.files) {
		const dir = f.path.split('/').slice(0, -1).join('/');
		const blobId = `imp_${now}_${seq++}`;
		const node: VfsNode = {
			id: `fil_${crypto.randomUUID()}`,
			parentId: dirIds.get(dir) ?? root.id,
			name: f.path.split('/').pop()!,
			kind: 'file',
			blobId,
			size: f.size,
			createdAt: now,
			updatedAt: now,
			sortOrder: seq,
			generation: 1
		};
		nodesToPut.push(node);

		if (f.pack) {
			const list = packMembers.get(f.pack) ?? [];
			list.push({
				blobId,
				offset: f.offset ?? 0,
				byteLength: f.size,
				contentType: f.contentType
			});
			packMembers.set(f.pack, list);
		} else {
			await vfs.migratePutBlob(blobId, byName.get(f.blob!)!, f.contentType);
		}
	}

	for (const [entryName, members] of packMembers) {
		const bytes = byName.get(entryName);
		if (!bytes) continue;
		await vfs.migratePutPack(
			`packs/pack_${crypto.randomUUID()}.bin`,
			new Blob([bytes as BlobPart]),
			members
		);
	}
	// Nodes last: a ref with no node is swept, a node with no bytes is loss.
	for (const n of nodesToPut) await vfs.migratePutNode(n);

	if (manifest.meta) {
		await writeProjectMeta(vfs, root.id, {
			...manifest.meta,
			updatedAt: new Date().toISOString()
		});
	}
	report({ stage: 'done', label: `Imported ${nodesToPut.length} files` });
	return {
		rootId: root.id,
		files: nodesToPut.length,
		meta: await readProjectMeta(vfs, root.id),
		mode: 'bundle',
		rebuiltAsBefore: true
	};
}
