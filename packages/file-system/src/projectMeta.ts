/**
 * Project identity and storage mode.
 *
 * The metadata is a FILE in the project folder, not a row in the VFS meta
 * table. That is the whole design: a file travels. It survives export and
 * import, it comes along when the folder is copied, git sees it, and a project
 * exported without one imports as an ordinary folder that can be initialised
 * later. A meta row would do none of that.
 *
 * `id` is the travelling project identity: two copies that share it are the
 * same project (the same collab room). It is minted on create, on import of a
 * file that has none, and when an older project is opened without one — never
 * on a second import of an export that already carries it.
 */
import type { VfsService } from './vfs.js';
import type { PackOpProgress, VfsNode } from './types.js';
import { descendantFiles } from './projectPack.js';

/** Lives in the project's own folder so it travels with the files. */
export const PROJECT_META_FILE = '.project.json';

export const PROJECT_META_SCHEMA_VERSION = 1;

export type ProjectMeta = {
	schemaVersion: number;
	/** Travelling identity. Same id, same project — including across import. */
	id?: string;
	name: string;
	description?: string;
	createdAt?: string;
	updatedAt?: string;
};

export function mintProjectId(): string {
	return crypto.randomUUID();
}

function hasProjectId(meta: ProjectMeta): meta is ProjectMeta & { id: string } {
	return typeof meta.id === 'string' && meta.id.length > 0;
}

function withProjectId(meta: ProjectMeta): ProjectMeta & { id: string } {
	return hasProjectId(meta) ? meta : { ...meta, id: mintProjectId() };
}

/**
 * `.project.json` body. A missing `id` is still a project — the id is adopted
 * on open / stamped on write, not required to parse.
 *
 * Extra fields are kept so a write-back (adopt-or-mint) cannot strip unknown
 * keys. `schemaVersion` stays 1; adding `id` is not a version bump.
 */
export function parseProjectMeta(raw: unknown): ProjectMeta | null {
	if (!raw || typeof raw !== 'object') return null;
	const rec = raw as Record<string, unknown>;
	if (typeof rec.name !== 'string') return null;
	const meta = { ...rec } as ProjectMeta;
	if (!hasProjectId(meta)) delete (meta as { id?: unknown }).id;
	return meta;
}

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
		const parsed = parseProjectMeta(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
		if (!parsed) return null;
		if (hasProjectId(parsed)) return parsed;
		// Adopt-or-mint: write the id back so an older file starts travelling.
		const adopted = withProjectId(parsed);
		try {
			await writeProjectMeta(vfs, rootId, adopted);
		} catch {
			// Still a project; the id will be retried next open.
		}
		return adopted;
	} catch {
		// A folder carrying an unreadable .project.json is still a folder. It
		// must not become an error the user cannot get past.
		return null;
	}
}

export async function isProject(vfs: VfsService, rootId: string): Promise<boolean> {
	return (await readProjectMeta(vfs, rootId)) !== null;
}

/** Write (or replace) the metadata file. An id-less body is stamped before it hits disk. */
export async function writeProjectMeta(
	vfs: VfsService,
	rootId: string,
	meta: ProjectMeta
): Promise<VfsNode> {
	const stamped = withProjectId(meta);
	const body = new TextEncoder().encode(`${JSON.stringify(stamped, null, 2)}\n`);
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
		id: existing?.id ?? mintProjectId(),
		name: opts.name,
		description: opts.description,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now
	};
	await writeProjectMeta(vfs, rootId, meta);
	if (opts.pack) {
		await packProject(vfs, rootId, { signal: opts.signal, onProgress: opts.onProgress });
	}
	return meta;
}

/** Files whose storage these actions may rewrite — everything but the metadata. */
async function packableFileIds(vfs: VfsService, rootId: string): Promise<string[]> {
	const files = await descendantFiles(vfs, rootId);
	return files.filter((f) => f.name !== PROJECT_META_FILE).map((f) => f.id);
}

/**
 * Pack everything in the project.
 *
 * There is deliberately no persisted "packed mode". Packs never build
 * themselves, and editing a file moves it out of its pack, so a stored flag
 * would claim the project was packed while half of it had drifted into
 * standalone blobs. What storage actually looks like is always the blobRefs;
 * this is an action, not a setting.
 *
 * The metadata file is left out on purpose: it has to be readable to know what
 * the project is, and burying identity inside the shared blob it describes is
 * a bad trade for a few hundred bytes.
 */
export async function packProject(
	vfs: VfsService,
	rootId: string,
	opts?: { signal?: AbortSignal; onProgress?: (ev: PackOpProgress) => void }
): Promise<{ packs: number; movedFiles: number }> {
	return vfs.repackNodes(await packableFileIds(vfs, rootId), opts);
}

/** Move everything back to one blob per file, so the folder is an ordinary folder. */
export async function unpackProject(
	vfs: VfsService,
	rootId: string,
	opts?: { signal?: AbortSignal; onProgress?: (ev: PackOpProgress) => void }
): Promise<{ movedFiles: number }> {
	return vfs.unpackNodes(await packableFileIds(vfs, rootId), opts);
}

/**
 * What the project's storage actually looks like right now.
 *
 * Computed, never stored, for the reason above: any cached answer is wrong as
 * soon as someone saves a file.
 */
export async function projectStorageStats(
	vfs: VfsService,
	rootId: string
): Promise<{
	files: number;
	packedFiles: number;
	driftedFiles: number;
	packs: number;
	liveBytes: number;
	deadBytes: number;
}> {
	const files = await descendantFiles(vfs, rootId);
	const packLive = new Map<string, number>();
	let packedFiles = 0;
	let driftedFiles = 0;
	let liveBytes = 0;
	for (const f of files) {
		if (!f.blobId) continue;
		const ref = await vfs.db.blobRefs.get(f.blobId);
		if (!ref) continue;
		liveBytes += ref.byteLength;
		if (ref.packOffset != null) {
			packedFiles += 1;
			packLive.set(ref.opfsPath, (packLive.get(ref.opfsPath) ?? 0) + ref.byteLength);
		} else if (f.name !== PROJECT_META_FILE) {
			driftedFiles += 1;
		}
	}
	let deadBytes = 0;
	for (const [path, live] of packLive) {
		try {
			deadBytes += Math.max(0, (await vfs.opfs.readBlob(path)).size - live);
		} catch {
			/* pack gone; gc reports it separately */
		}
	}
	return {
		files: files.length,
		packedFiles,
		driftedFiles,
		packs: packLive.size,
		liveBytes,
		deadBytes
	};
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
	return vfs.repackNodes(await packableFileIds(vfs, rootId), opts);
}
