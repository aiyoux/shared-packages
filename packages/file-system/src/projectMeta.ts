/**
 * Project identity and storage mode.
 *
 * The metadata is a FILE in the project folder, not a row in the VFS meta
 * table. That is the whole design: a file travels. It survives export and
 * import, it comes along when the folder is copied, git sees it, and a project
 * exported without one imports as an ordinary folder that can be initialised
 * later. A meta row would do none of that.
 */
import type { VfsService } from './vfs.js';
import type { PackOpProgress, VfsNode } from './types.js';
import { descendantFiles } from './projectPack.js';

/** Lives in the project's own folder so it travels with the files. */
export const PROJECT_META_FILE = '.project.json';

export const PROJECT_META_SCHEMA_VERSION = 1;

export type ProjectMeta = {
	schemaVersion: number;
	name: string;
	description?: string;
	/**
	 * Whether the project's files are stored in shared packs.
	 *
	 * Recorded so an export can say how it was, and an import can offer to
	 * rebuild it that way — not as the source of truth for what storage
	 * currently looks like, which is always the blobRefs.
	 */
	packed?: boolean;
	createdAt?: string;
	updatedAt?: string;
};

function metaFileIn(vfs: VfsService, rootId: string): Promise<VfsNode | undefined> {
	return vfs
		.list({ parentId: rootId })
		.then((rows) => rows.find((n) => n.kind === 'file' && n.name === PROJECT_META_FILE));
}

/** The project's metadata, or null when the folder is just a folder. */
export async function readProjectMeta(
	vfs: VfsService,
	rootId: string
): Promise<ProjectMeta | null> {
	const node = await metaFileIn(vfs, rootId);
	if (!node) return null;
	try {
		const bytes = await vfs.readBytes(node.id);
		const raw = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
		if (!raw || typeof raw !== 'object') return null;
		const meta = raw as ProjectMeta;
		if (typeof meta.name !== 'string') return null;
		return meta;
	} catch {
		// A folder carrying an unreadable .project.json is still a folder. It
		// must not become an error the user cannot get past.
		return null;
	}
}

export async function isProject(vfs: VfsService, rootId: string): Promise<boolean> {
	return (await readProjectMeta(vfs, rootId)) !== null;
}

/** Write (or replace) the metadata file. */
export async function writeProjectMeta(
	vfs: VfsService,
	rootId: string,
	meta: ProjectMeta
): Promise<VfsNode> {
	const body = new TextEncoder().encode(`${JSON.stringify(meta, null, 2)}\n`);
	const existing = await metaFileIn(vfs, rootId);
	if (existing) {
		return vfs.updateFile(existing.id, body, { force: true, contentType: 'application/json' });
	}
	return vfs.writeFile({
		parentId: rootId,
		name: PROJECT_META_FILE,
		body,
		contentType: 'application/json'
	});
}

/**
 * Make an ordinary folder a project.
 *
 * Packing is optional and off unless asked for: turning a folder into a
 * project is a naming decision, and moving its bytes into shared storage is a
 * separate one with different consequences.
 */
export async function initProject(
	vfs: VfsService,
	rootId: string,
	opts: {
		name: string;
		description?: string;
		pack?: boolean;
		signal?: AbortSignal;
		onProgress?: (ev: PackOpProgress) => void;
	}
): Promise<ProjectMeta> {
	const now = new Date().toISOString();
	const existing = await readProjectMeta(vfs, rootId);
	const meta: ProjectMeta = {
		schemaVersion: PROJECT_META_SCHEMA_VERSION,
		name: opts.name,
		description: opts.description,
		packed: opts.pack === true,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now
	};
	await writeProjectMeta(vfs, rootId, meta);
	if (opts.pack) {
		await setProjectPacked(vfs, rootId, true, {
			signal: opts.signal,
			onProgress: opts.onProgress
		});
	}
	return meta;
}

/**
 * Switch a project between packed and ordinary storage.
 *
 * Unpacked, the folder is indistinguishable from any other part of the
 * filesystem — which is the point: packing should be reversible, not a
 * one-way door.
 *
 * The metadata file itself is deliberately left OUT of the pack. It has to be
 * readable to know what the project is, and burying identity inside the shared
 * blob it describes is a bad trade for the few hundred bytes it saves.
 */
export async function setProjectPacked(
	vfs: VfsService,
	rootId: string,
	packed: boolean,
	opts?: { signal?: AbortSignal; onProgress?: (ev: PackOpProgress) => void }
): Promise<{ packed: boolean; movedFiles: number }> {
	const files = await descendantFiles(vfs, rootId);
	const ids = files.filter((f) => f.name !== PROJECT_META_FILE).map((f) => f.id);

	const result = packed
		? await vfs.repackNodes(ids, opts)
		: await vfs.unpackNodes(ids, opts);

	const meta = await readProjectMeta(vfs, rootId);
	if (meta) {
		await writeProjectMeta(vfs, rootId, {
			...meta,
			packed,
			updatedAt: new Date().toISOString()
		});
	}
	return { packed, movedFiles: result.movedFiles };
}

/**
 * Reclaim dead space and pull back anything that drifted out.
 *
 * Distinct from the automatic sweep, which only reclaims: re-absorbing files
 * that editing moved to their own blobs changes where live data lives, so it
 * stays a deliberate action.
 */
export async function compactProject(
	vfs: VfsService,
	rootId: string,
	opts?: { signal?: AbortSignal; onProgress?: (ev: PackOpProgress) => void }
): Promise<{ packs: number; movedFiles: number }> {
	const meta = await readProjectMeta(vfs, rootId);
	if (meta?.packed === false) return { packs: 0, movedFiles: 0 };
	const files = await descendantFiles(vfs, rootId);
	const ids = files.filter((f) => f.name !== PROJECT_META_FILE).map((f) => f.id);
	return vfs.repackNodes(ids, opts);
}
