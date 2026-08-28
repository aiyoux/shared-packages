/**
 * OS / desktop file+folder drops into an ExplorerDriver.
 *
 * Chromium revokes `DataTransfer.files` from a dropped *directory* once the
 * drop handler returns (`NotFoundError`). `webkitGetAsEntry()` /
 * `getAsFileSystemHandle()` must be called in that same turn; those handles
 * stay readable. Snapshot bytes into in-memory `File`s, then mkdir + write.
 */
import type { ExplorerDriver, ExplorerEntryId } from './explorerDriver.js';
import { formatExplorerError } from './explorerError.js';

export type OsDropNode = {
	/** POSIX relative path from the drop root. Folders have no trailing slash. */
	relativePath: string;
	kind: 'file' | 'folder';
	/** In-memory snapshot; set for files. */
	file?: File;
};

type EntryLike = {
	isFile: boolean;
	isDirectory: boolean;
	name: string;
	file?: (ok: (f: File) => void, err?: (e: Error) => void) => void;
	createReader?: () => {
		readEntries: (ok: (entries: EntryLike[]) => void, err?: (e: Error) => void) => void;
	};
};

function relativePathOf(file: File): string {
	const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
	const s = (rel && String(rel).replace(/\\/g, '/')) || file.name;
	return s.replace(/^\/+/, '');
}

function readFileBytes(file: File): Promise<ArrayBuffer> {
	// FileReader starts the read now. `file.arrayBuffer()` on a dropped-folder
	// File is often deferred until await, which is after Chromium revokes it.
	if (typeof FileReader !== 'undefined') {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const buf = reader.result;
				if (buf instanceof ArrayBuffer) resolve(buf);
				else reject(new Error('Could not read dropped file'));
			};
			reader.onerror = () =>
				reject(reader.error ?? new Error('Could not read dropped file'));
			try {
				reader.readAsArrayBuffer(file);
			} catch (e) {
				reject(e instanceof Error ? e : new Error('Could not read dropped file'));
			}
		});
	}
	if (file && typeof file.arrayBuffer === 'function') return file.arrayBuffer();
	if (typeof Response !== 'undefined') {
		try {
			return new Response(file).arrayBuffer();
		} catch {
			/* fall through */
		}
	}
	return Promise.reject(new Error('Could not read dropped file'));
}

async function snapshotFile(file: File): Promise<File> {
	try {
		const buf = await readFileBytes(file);
		return new File([buf], file.name, {
			type: file.type || 'application/octet-stream',
			lastModified: file.lastModified
		});
	} catch (e) {
		throw new Error(formatExplorerError(e));
	}
}

function folderPathsFromFilePath(rel: string): string[] {
	const parts = rel.split('/').filter(Boolean);
	if (parts.length < 2) return [];
	const out: string[] = [];
	let acc = '';
	for (let i = 0; i < parts.length - 1; i++) {
		acc = acc ? `${acc}/${parts[i]}` : parts[i];
		out.push(acc);
	}
	return out;
}

export function nodesFromFiles(files: File[]): OsDropNode[] {
	const folders = new Set<string>();
	const nodes: OsDropNode[] = [];
	for (const file of files) {
		const rel = relativePathOf(file);
		for (const dir of folderPathsFromFilePath(rel)) folders.add(dir);
		nodes.push({ relativePath: rel, kind: 'file', file });
	}
	return [...[...folders].sort().map((p) => ({ relativePath: p, kind: 'folder' as const })), ...nodes];
}

export async function snapshotFiles(files: File[]): Promise<OsDropNode[]> {
	const folders = new Set<string>();
	const nodes: OsDropNode[] = [];
	for (const f of files) {
		const rel = relativePathOf(f);
		for (const dir of folderPathsFromFilePath(rel)) folders.add(dir);
		const copy = await snapshotFile(f);
		nodes.push({ relativePath: rel, kind: 'file', file: copy });
	}
	return [
		...[...folders].sort().map((p) => ({ relativePath: p, kind: 'folder' as const })),
		...nodes
	];
}

function readEntryFile(entry: EntryLike): Promise<File> {
	return new Promise((resolve, reject) => {
		if (typeof entry.file !== 'function') {
			reject(new Error('Dropped item is not a readable file'));
			return;
		}
		entry.file(resolve, reject);
	});
}

function readDirEntries(entry: EntryLike): Promise<EntryLike[]> {
	return new Promise((resolve, reject) => {
		if (typeof entry.createReader !== 'function') {
			resolve([]);
			return;
		}
		const reader = entry.createReader();
		const all: EntryLike[] = [];
		const pump = () => {
			reader.readEntries(
				(batch) => {
					if (!batch.length) {
						resolve(all);
						return;
					}
					all.push(...batch);
					pump();
				},
				reject
			);
		};
		pump();
	});
}

async function walkEntry(entry: EntryLike, prefix: string): Promise<OsDropNode[]> {
	const name = entry.name || 'untitled';
	const rel = prefix ? `${prefix}/${name}` : name;
	if (entry.isFile) {
		const file = await readEntryFile(entry);
		const snap = await snapshotFile(file);
		return [{ relativePath: rel, kind: 'file', file: snap }];
	}
	if (entry.isDirectory) {
		const kids = await readDirEntries(entry);
		const out: OsDropNode[] = [{ relativePath: rel, kind: 'folder' }];
		for (const kid of kids) {
			out.push(...(await walkEntry(kid, rel)));
		}
		return out;
	}
	return [];
}

/** `values()` post-dates the TS lib types for FileSystemDirectoryHandle. */
type DirHandleWithValues = FileSystemDirectoryHandle & {
	values?: () => AsyncIterableIterator<FileSystemHandle>;
};

async function walkHandle(handle: FileSystemHandle, prefix: string): Promise<OsDropNode[]> {
	const rel = prefix ? `${prefix}/${handle.name}` : handle.name;
	if (handle.kind === 'file') {
		const file = await (handle as FileSystemFileHandle).getFile();
		const snap = await snapshotFile(file);
		return [{ relativePath: rel, kind: 'file', file: snap }];
	}
	if (handle.kind !== 'directory') return [];
	const dir = handle as DirHandleWithValues;
	const out: OsDropNode[] = [{ relativePath: rel, kind: 'folder' }];
	if (typeof dir.values === 'function') {
		for await (const child of dir.values()) {
			out.push(...(await walkHandle(child, rel)));
		}
	}
	return out;
}

function nodesFromSnapshottedFiles(
	files: File[],
	rels: string[]
): OsDropNode[] {
	const folders = new Set<string>();
	const nodes: OsDropNode[] = [];
	for (let i = 0; i < files.length; i++) {
		const rel = rels[i] || files[i]!.name;
		for (const dir of folderPathsFromFilePath(rel)) folders.add(dir);
		nodes.push({ relativePath: rel, kind: 'file', file: files[i] });
	}
	return [
		...[...folders].sort().map((p) => ({ relativePath: p, kind: 'folder' as const })),
		...nodes
	];
}

async function snapshotPending(
	pending: Array<{
		rel: string;
		name: string;
		type: string;
		lastModified: number;
		bytes: Promise<ArrayBuffer>;
	}>
): Promise<OsDropNode[]> {
	const files: File[] = [];
	const rels: string[] = [];
	for (const p of pending) {
		let buf: ArrayBuffer;
		try {
			buf = await p.bytes;
		} catch (e) {
			throw new Error(formatExplorerError(e));
		}
		files.push(
			new File([buf], p.name, {
				type: p.type || 'application/octet-stream',
				lastModified: p.lastModified
			})
		);
		rels.push(p.rel);
	}
	return nodesFromSnapshottedFiles(files, rels);
}

type DropItem = DataTransferItem & {
	getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
	webkitGetAsEntry?: () => EntryLike | null;
	getAsEntry?: () => EntryLike | null;
};

/**
 * Capture a DataTransfer on drop. Must run inside the drop handler:
 * Chromium revokes directory `File` objects once the handler returns.
 *
 * Prefer File System Access handles / `webkitGetAsEntry` when the drop
 * includes a folder. `dt.files` is only safe for flat file drops.
 */
export function collectOsDrop(dt: DataTransfer | null | undefined): Promise<OsDropNode[]> {
	if (!dt) return Promise.resolve([]);

	type Captured = {
		handleP?: Promise<FileSystemHandle | null>;
		entry: EntryLike | null;
	};
	const captured: Captured[] = [];
	const items = dt.items;
	const secure =
		typeof globalThis.isSecureContext !== 'boolean' || globalThis.isSecureContext;
	if (items?.length) {
		for (let i = 0; i < items.length; i++) {
			const item = items[i] as DropItem | undefined;
			if (!item || item.kind !== 'file') continue;
			const handleP =
				secure && typeof item.getAsFileSystemHandle === 'function'
					? item.getAsFileSystemHandle()
					: undefined;
			const getEntry = item.getAsEntry ?? item.webkitGetAsEntry;
			const entry = typeof getEntry === 'function' ? getEntry.call(item) : null;
			captured.push({
				handleP,
				entry: entry && (entry.isFile || entry.isDirectory) ? entry : null
			});
		}
	}

	const filesNow: File[] = dt.files?.length ? Array.from(dt.files) : [];
	const listPending = filesNow.map((f) => {
		const bytes = readFileBytes(f);
		bytes.catch(() => {
			/* used only if handles/entries fail; avoid unhandled rejection */
		});
		return {
			rel: relativePathOf(f),
			name: f.name,
			type: f.type,
			lastModified: f.lastModified,
			bytes
		};
	});

	return (async () => {
		const fromHandles: OsDropNode[] = [];
		for (const c of captured) {
			if (!c.handleP) continue;
			try {
				const handle = await c.handleP;
				if (handle) fromHandles.push(...(await walkHandle(handle, '')));
			} catch {
				/* entries / FileList */
			}
		}
		if (fromHandles.length) return fromHandles;

		const fromEntries: OsDropNode[] = [];
		let entryErr: unknown;
		for (const c of captured) {
			if (!c.entry) continue;
			try {
				fromEntries.push(...(await walkEntry(c.entry, '')));
			} catch (e) {
				entryErr ??= e;
			}
		}
		if (fromEntries.length) return fromEntries;

		if (listPending.length) return snapshotPending(listPending);

		if (entryErr) throw new Error(formatExplorerError(entryErr));
		return [];
	})();
}

export class OsDropError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OsDropError';
	}
}

export type OsDropFileProgress = {
	name: string;
	size: number;
	transferred: number;
	done: boolean;
};

/**
 * Recreate a dropped file/folder tree on any explorer backend.
 * Requires `mkdir` when the drop contains nested paths.
 */
export async function importOsDropToDriver(
	driver: ExplorerDriver,
	destParentId: ExplorerEntryId | null,
	nodes: OsDropNode[],
	opts?: { onFile?: (ev: OsDropFileProgress) => void }
): Promise<{ files: number; folders: number }> {
	const put = driver.upload ?? driver.writeFile;
	if (!put) {
		throw new OsDropError('This location cannot receive files from your computer.');
	}
	if (!nodes.length) return { files: 0, folders: 0 };

	const nested = nodes.some((n) => n.kind === 'folder' || n.relativePath.includes('/'));
	if (nested && typeof driver.mkdir !== 'function') {
		throw new OsDropError(
			'This connection cannot create folders. Drop individual files, or zip the folder first.'
		);
	}

	const folderIds = new Map<string, ExplorerEntryId | null>();
	folderIds.set('', destParentId);

	const ensureFolder = async (relDir: string): Promise<ExplorerEntryId | null> => {
		if (!relDir) return destParentId;
		const hit = folderIds.get(relDir);
		if (hit !== undefined) return hit;
		const slash = relDir.lastIndexOf('/');
		const parentRel = slash >= 0 ? relDir.slice(0, slash) : '';
		const name = slash >= 0 ? relDir.slice(slash + 1) : relDir;
		const parentId = await ensureFolder(parentRel);
		const created = await driver.mkdir!(parentId, name);
		folderIds.set(relDir, created.id);
		return created.id;
	};

	let files = 0;
	let folders = 0;
	for (const n of nodes) {
		if (n.kind === 'folder') {
			await ensureFolder(n.relativePath);
			folders += 1;
		}
	}
	// Group by destination folder so a driver with a bulk write can take a
	// whole folder in one call. Dropping a 3000-file tree used to be 3000
	// separate writes; each one is ~4 OPFS round trips, and that per-file cost
	// dominates the drop regardless of how large the files are.
	const byParent = new Map<string, { parentId: string | null; files: File[] }>();
	for (const n of nodes) {
		if (n.kind !== 'file' || !n.file) continue;
		const slash = n.relativePath.lastIndexOf('/');
		const dir = slash >= 0 ? n.relativePath.slice(0, slash) : '';
		const parentId = await ensureFolder(dir);
		const key = parentId ?? '';
		const group = byParent.get(key);
		if (group) group.files.push(n.file);
		else byParent.set(key, { parentId, files: [n.file] });
	}

	for (const { parentId, files: group } of byParent.values()) {
		// upload() carries per-file progress that the bulk path cannot express,
		// so a driver offering it keeps the per-file route.
		const bulk = typeof driver.upload !== 'function' && typeof driver.writeFiles === 'function';
		if (bulk) {
			for (const file of group) {
				opts?.onFile?.({ name: file.name, size: file.size, transferred: 0, done: false });
			}
			let settled = 0;
			const settle = (upTo: number) => {
				while (settled < upTo) {
					const file = group[settled++]!;
					opts?.onFile?.({
						name: file.name,
						size: file.size,
						transferred: file.size,
						done: true
					});
					files += 1;
				}
			};
			await driver.writeFiles!(parentId, group, {
				onProgress: (written) => settle(Math.min(settled + written.length, group.length))
			});
			settle(group.length);
			continue;
		}
		for (const file of group) {
			const size = file.size;
			const name = file.name;
			opts?.onFile?.({ name, size, transferred: 0, done: false });
			if (typeof driver.upload === 'function') {
				await driver.upload(parentId, file, {
					onProgress: (pct) => {
						const transferred = Math.round(size * Math.min(1, Math.max(0, pct)));
						opts?.onFile?.({ name, size, transferred, done: false });
					}
				});
			} else {
				await driver.writeFile!(parentId, file);
				opts?.onFile?.({ name, size, transferred: size, done: false });
			}
			opts?.onFile?.({ name, size, transferred: size, done: true });
			files += 1;
		}
	}
	return { files, folders };
}
