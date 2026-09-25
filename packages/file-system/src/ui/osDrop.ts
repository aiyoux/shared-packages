/**
 * OS / desktop file+folder drops into an ExplorerDriver.
 *
 * Chromium revokes `DataTransfer.files` from a dropped *directory* once the
 * drop handler returns (`NotFoundError`). `webkitGetAsEntry()` /
 * `getAsFileSystemHandle()` must be called in that same turn; those handles
 * stay readable. FileList fallback bytes are snapshotted during the drop;
 * handle-backed files are opened when the destination is ready to write.
 */
import type { ExplorerDriver, ExplorerEntryId } from './explorerDriver.js';
import { formatExplorerError } from './explorerError.js';
import { attachTransferAbort, upsertProgress } from '../transferRegistry.js';
import { generateId } from '../id.js';

export type OsDropNode = {
	/** POSIX relative path from the drop root. Folders have no trailing slash. */
	relativePath: string;
	kind: 'file' | 'folder';
	/** A captured FileList snapshot or picker File. */
	file?: File;
	/** A persistent drop entry/handle, opened when the destination writes. */
	loadFile?: () => Promise<File>;
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
	const nodes = await mapBounded(files, 8, async (f): Promise<OsDropNode> => {
		const rel = relativePathOf(f);
		const copy = await snapshotFile(f);
		return { relativePath: rel, kind: 'file', file: copy };
	});
	for (const node of nodes) {
		for (const dir of folderPathsFromFilePath(node.relativePath)) folders.add(dir);
	}
	return [
		...[...folders].sort().map((p) => ({ relativePath: p, kind: 'folder' as const })),
		...nodes
	];
}

async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let cursor = 0;
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) {
			const i = cursor++;
			out[i] = await fn(items[i]!);
		}
	}));
	return out;
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
		return [{ relativePath: rel, kind: 'file', loadFile: () => readEntryFile(entry) }];
	}
	if (entry.isDirectory) {
		const kids = await readDirEntries(entry);
		const out: OsDropNode[] = [{ relativePath: rel, kind: 'folder' }];
		const children = await mapBounded(kids, 8, (kid) => walkEntry(kid, rel));
		for (const child of children) out.push(...child);
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
		return [{
			relativePath: rel, kind: 'file',
			loadFile: () => (handle as FileSystemFileHandle).getFile()
		}];
	}
	if (handle.kind !== 'directory') return [];
	const dir = handle as DirHandleWithValues;
	const out: OsDropNode[] = [{ relativePath: rel, kind: 'folder' }];
	if (typeof dir.values === 'function') {
		const children: FileSystemHandle[] = [];
		for await (const child of dir.values()) children.push(child);
		const walked = await mapBounded(children, 8, (child) => walkHandle(child, rel));
		for (const child of walked) out.push(...child);
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
	const listPending = (captured.some((c) => c.entry?.isDirectory) ? [] : filesNow).map((f) => {
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
		if (filesNow.length === captured.length && captured.every((c) => c.entry?.isFile)) {
			return snapshotPending(listPending);
		}
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
	relativePath?: string;
	parentId?: ExplorerEntryId | null;
	entryKind?: 'file' | 'folder';
};

/**
 * One PC → destination import registered in the transfer registry, so it
 * shows in the explorer's top header bar like any other transfer — an import
 * from the user's computer is a transfer into the open destination, whether
 * that destination is a remote backend (monitor / b2 / rclone) or a local
 * folder. The listing keeps its pending rows; the header carries the
 * transfer-shaped view with a dismiss/cancel affordance, and a failed or
 * cancelled import marks its rows instead of leaving them spinning.
 */
export function createDeviceImportReporter(driver: { id: string }): {
	onFile: (ev: OsDropFileProgress) => void;
	fail: (err: unknown) => void;
	signal: AbortSignal;
} {
	const ac = new AbortController();
	const ids = new Map<string, { id: string; name: string; size: number }>();
	const idOf = (ev: OsDropFileProgress): string => {
		const key = ev.relativePath ?? ev.name;
		let item = ids.get(key);
		if (!item) {
			item = { id: generateId('import'), name: ev.name, size: ev.size };
			ids.set(key, item);
			attachTransferAbort(item.id, ac);
		}
		return item.id;
	};
	const report = (
		ev: OsDropFileProgress,
		patch?: { status?: 'cancelled' | 'failed'; error?: string }
	) => {
		upsertProgress({
			id: idOf(ev),
			name: ev.name,
			size: ev.size,
			transferred: ev.transferred,
			direction: 'copying',
			done: patch ? true : ev.done,
			status: patch?.status ?? (ev.done ? 'done' : 'active'),
			error: patch?.error
		});
	};
	return {
		onFile: report,
		fail(err) {
			const aborted = err instanceof Error && err.name === 'AbortError';
			const msg = err instanceof Error ? err.message : String(err);
			const status = aborted ? 'cancelled' : 'failed';
			for (const { id, name, size } of ids.values()) {
				upsertProgress({
					id,
					name,
					size,
					transferred: 0,
					direction: 'copying',
					done: true,
					status,
					error: aborted ? undefined : msg
				});
			}
		},
		get signal() {
			return ac.signal;
		}
	};
}

/**
 * Recreate a dropped file/folder tree on any explorer backend.
 * Requires `mkdir` when the drop contains nested paths.
 */
export async function importOsDropToDriver(
	driver: ExplorerDriver,
	destParentId: ExplorerEntryId | null,
	nodes: OsDropNode[],
	opts?: { onFile?: (ev: OsDropFileProgress) => void; signal?: AbortSignal }
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
	const folderNames = new Map<string, string>();
	folderIds.set('', destParentId);
	const abortIfNeeded = () => {
		if (!opts?.signal?.aborted) return;
		const error = new Error('Import cancelled');
		error.name = 'AbortError';
		throw error;
	};

	const ensureFolder = async (relDir: string): Promise<ExplorerEntryId | null> => {
		if (!relDir) return destParentId;
		const hit = folderIds.get(relDir);
		if (hit !== undefined) return hit;
		abortIfNeeded();
		const slash = relDir.lastIndexOf('/');
		const parentRel = slash >= 0 ? relDir.slice(0, slash) : '';
		const name = slash >= 0 ? relDir.slice(slash + 1) : relDir;
		const parentId = await ensureFolder(parentRel);
		const created = await driver.mkdir!(parentId, name);
		folderIds.set(relDir, created.id);
		folderNames.set(relDir, created.name);
		return created.id;
	};

	let files = 0;
	let folders = 0;
	const folderPaths = new Set<string>();
	for (const node of nodes) {
		if (node.kind === 'folder') folderPaths.add(node.relativePath);
		else for (const path of folderPathsFromFilePath(node.relativePath)) folderPaths.add(path);
	}
	const sortedFolders = [...folderPaths].sort((a, b) =>
		a.split('/').length - b.split('/').length || a.localeCompare(b)
	);
	// Top-level folders must be freshly named by mkdir. Within those new
	// folders, the local driver can reserve the remaining tree in one batch.
	for (const path of sortedFolders.filter((p) => !p.includes('/'))) {
		await ensureFolder(path);
	}
	if (driver.ensureFolders) {
		for (const root of sortedFolders.filter((p) => !p.includes('/'))) {
			const descendants = sortedFolders
				.filter((p) => p.startsWith(`${root}/`))
				.map((p) => p.slice(root.length + 1).split('/'));
			if (!descendants.length) continue;
			abortIfNeeded();
			const mapped = await driver.ensureFolders(folderIds.get(root)!, descendants, {
				signal: opts?.signal
			});
			for (const [path, id] of mapped) {
				if (path) {
					folderIds.set(`${root}/${path}`, id);
					folderNames.set(`${root}/${path}`, path.split('/').at(-1)!);
				}
			}
		}
	}
	for (const path of sortedFolders) await ensureFolder(path);
	folders = nodes.filter((n) => n.kind === 'folder').length;

	type Planned = { node: OsDropNode; file: File; parentId: ExplorerEntryId | null };
	const planned: Planned[] = await mapBounded(
		nodes.filter((n) => n.kind === 'file'), 8,
		async (n) => {
			abortIfNeeded();
			const file = n.file ?? await n.loadFile?.();
			if (!file) throw new OsDropError(`Could not read ${n.relativePath}`);
			const slash = n.relativePath.lastIndexOf('/');
			const dir = slash >= 0 ? n.relativePath.slice(0, slash) : '';
			return { node: n, file, parentId: await ensureFolder(dir) };
		}
	);
	const folderTotals = new Map<string, { size: number; transferred: number; count: number; completed: number }>();
	for (const path of sortedFolders) folderTotals.set(path, { size: 0, transferred: 0, count: 0, completed: 0 });
	for (const p of planned) {
		for (const path of folderPathsFromFilePath(p.node.relativePath)) {
			const total = folderTotals.get(path);
			if (total) {
				total.size += p.file.size;
				total.count++;
			}
		}
	}
	const emitFolder = (path: string) => {
		const slash = path.lastIndexOf('/');
		const parentPath = slash < 0 ? '' : path.slice(0, slash);
		const total = folderTotals.get(path)!;
		opts?.onFile?.({
			name: folderNames.get(path) ?? path.slice(slash + 1), relativePath: path,
			parentId: folderIds.get(parentPath) ?? destParentId,
			entryKind: 'folder', size: total.size,
			transferred: total.transferred, done: total.completed >= total.count
		});
	};
	for (const path of sortedFolders) emitFolder(path);
	abortIfNeeded();
	const emitFile = (p: Planned, transferred: number, done: boolean) => {
		opts?.onFile?.({
			name: p.file.name, relativePath: p.node.relativePath,
			parentId: p.parentId, entryKind: 'file',
			size: p.file.size, transferred, done
		});
	};
	const settleFile = (p: Planned) => {
		emitFile(p, p.file.size, true);
		files += 1;
		for (const path of folderPathsFromFilePath(p.node.relativePath)) {
			const total = folderTotals.get(path);
			if (total) {
				total.transferred += p.file.size;
				total.completed++;
				emitFolder(path);
			}
		}
	};

	// Local VFS can write a mixed-parent tree in one chunked call. It preserves
	// each file's actual parent without paying a reserve/confirm cycle per dir.
	if (!driver.upload && driver.writeFilesAcross && planned.length) {
		for (const p of planned) emitFile(p, 0, false);
		abortIfNeeded();
		let settled = 0;
		await driver.writeFilesAcross(
			planned.map((p) => ({ parentId: p.parentId, name: p.file.name, body: p.file })),
			{
				signal: opts?.signal,
				onProgress: (written) => {
					for (let i = 0; i < written.length && settled < planned.length; i++) {
						settleFile(planned[settled++]!);
					}
				}
			}
		);
		abortIfNeeded();
		while (settled < planned.length) settleFile(planned[settled++]!);
		return { files, folders };
	}

	const byParent = new Map<string, { parentId: ExplorerEntryId | null; items: Planned[] }>();
	for (const p of planned) {
		const key = p.parentId ?? '';
		const group = byParent.get(key);
		if (group) group.items.push(p);
		else byParent.set(key, { parentId: p.parentId, items: [p] });
	}

	for (const { parentId, items: group } of byParent.values()) {
		abortIfNeeded();
		// upload() carries per-file progress that the bulk path cannot express,
		// so a driver offering it keeps the per-file route.
		const bulk = typeof driver.upload !== 'function' && typeof driver.writeFiles === 'function';
		if (bulk) {
			for (const p of group) emitFile(p, 0, false);
			abortIfNeeded();
			let settled = 0;
			const settle = (upTo: number) => {
				while (settled < upTo) {
					settleFile(group[settled++]!);
				}
			};
			await driver.writeFiles!(parentId, group.map((p) => p.file), {
				signal: opts?.signal,
				onProgress: (written) => settle(Math.min(settled + written.length, group.length))
			});
			abortIfNeeded();
			settle(group.length);
			continue;
		}
		for (const p of group) {
			abortIfNeeded();
			const { file } = p;
			const size = file.size;
			emitFile(p, 0, false);
			if (typeof driver.upload === 'function') {
				await driver.upload(parentId, file, {
					signal: opts?.signal,
					onProgress: (pct) => {
						const transferred = Math.round(size * Math.min(1, Math.max(0, pct)));
						emitFile(p, transferred, false);
					}
				});
			} else {
				await driver.writeFile!(parentId, file);
				emitFile(p, size, false);
			}
			settleFile(p);
		}
	}
	abortIfNeeded();
	return { files, folders };
}
