/**
 * Pack / unpack FileExplorer rows via @shared-packages/compress and crypto.
 * Used by FeArchiveDialog and the inner-filesystem popup.
 */
import {
	ENGINE_CATALOG,
	DEFAULT_ENGINE as DEFAULT_COMPRESS_ENGINE,
	detectFormat,
	detectFormatFromName,
	engineSupports,
	expandBytes,
	isJunkArchivePath,
	packFiles,
	type ArchiveEntry,
	type Codec,
	type EngineId as CompressEngineId
} from '@shared-packages/compress';
import {
	DEFAULT_ENGINE as DEFAULT_CRYPTO_ENGINE,
	isVaultBytes,
	isVaultName,
	openVault,
	sealVault,
	type EngineId as CryptoEngineId
} from '@shared-packages/crypto';
import { getMemoryVfs } from '../memoryVfs.js';
import { createMemoryExplorerDriver } from './memoryExplorerDriver.js';
import { createVfs, type VfsService } from '../vfs.js';
import type { ExplorerDriver, ExplorerEntry } from './explorerDriver.js';
import { createLocalExplorerDriver } from './localExplorerDriver.js';

export const COMPRESS_STORAGE_KEY = 'scratchpad-compress-engine';
export const CRYPTO_STORAGE_KEY = 'scratchpad-crypto-engine';

export type ArchiveKind = 'compress' | 'encrypt' | 'decompress' | 'decrypt';
export type ArchiveDest = 'same' | 'folder' | 'memory' | 'popup';

export type PackedPath = {
	path: string;
	data: Uint8Array;
};

/** Dest-file listing row while compress / decompress / encrypt / decrypt writes. */
export type ArchiveWriteProgress = {
	name: string;
	parentId: string | null;
	transferred: number;
	size: number;
	done: boolean;
	/** Header-chip only — do not paint a dest listing row. */
	job?: boolean;
};

function yieldPaint(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const e = new Error('Cancelled');
	e.name = 'AbortError';
	throw e;
}

export function packedBasename(path: string): string {
	const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
	return parts[parts.length - 1] || path;
}

/** True when the archive member lands in `parent` rather than a nested folder. */
export function packedIsTopLevel(path: string): boolean {
	const parts = path.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.' && p !== '..');
	return parts.length <= 1;
}

export type InnerFsSession = {
	title: string;
	driver: ExplorerDriver;
	dispose: () => Promise<void>;
};

export function looksCompressedName(name: string): boolean {
	return detectFormatFromName(name) != null;
}

export function looksVaultName(name: string): boolean {
	return isVaultName(name);
}

export function looksPackedName(name: string): boolean {
	return looksCompressedName(name) || looksVaultName(name);
}

export function readStoredCompressEngine(): CompressEngineId {
	try {
		const v = localStorage.getItem(COMPRESS_STORAGE_KEY);
		if (v === 'fflate' || v === 'zipkit' || v === 'addmaple') return v;
	} catch {
		/* ignore */
	}
	return DEFAULT_COMPRESS_ENGINE;
}

export function readStoredCryptoEngine(): CryptoEngineId {
	try {
		const v = localStorage.getItem(CRYPTO_STORAGE_KEY);
		if (v === 'webcrypto' || v === 'libsodium') return v;
	} catch {
		/* ignore */
	}
	return DEFAULT_CRYPTO_ENGINE;
}

export function pickEngineForCodec(
	preferred: CompressEngineId,
	codec: Codec
): CompressEngineId {
	if (engineSupports(preferred, codec)) return preferred;
	const found = ENGINE_CATALOG.find((e) => e.codecs.includes(codec));
	if (!found) throw new Error(`No installed library can expand ${codec}`);
	return found.id;
}

export function packingAsTree(entries: ExplorerEntry[]): boolean {
	return entries.length !== 1 || entries.some((e) => e.kind === 'folder');
}

export function subjectLabel(entries: ExplorerEntry[]): string {
	if (entries.length === 1) return entries[0]!.name;
	if (entries.length > 1) return `${entries.length} items`;
	return 'items';
}

export async function readEntryBytes(
	driver: ExplorerDriver,
	entry: ExplorerEntry
): Promise<Uint8Array> {
	const blob = driver.readBlob
		? await driver.readBlob(entry.id)
		: await driver.download?.(entry.id);
	if (!blob) throw new Error('This connection cannot read the file');
	return new Uint8Array(await blob.arrayBuffer());
}

export async function collectPackEntries(
	driver: ExplorerDriver,
	entries: ExplorerEntry[],
	opts?: { signal?: AbortSignal; onFile?: (packed: number) => void }
): Promise<PackedPath[]> {
	const out: PackedPath[] = [];
	async function walk(entry: ExplorerEntry, prefix: string) {
		throwIfAborted(opts?.signal);
		if (entry.kind === 'file') {
			const data = await readEntryBytes(driver, entry);
			const path = prefix ? `${prefix}/${entry.name}` : entry.name;
			out.push({ path, data });
			opts?.onFile?.(out.length);
			return;
		}
		const listed = await driver.list({ parentId: entry.id });
		const next = prefix ? `${prefix}/${entry.name}` : entry.name;
		for (const child of listed.entries) await walk(child, next);
	}
	for (const entry of entries) await walk(entry, '');
	if (!out.length) throw new Error('Nothing to pack');
	return out;
}

function splitPackedPath(path: string): { dirs: string[]; file: string | null } {
	const trimmed = path.replace(/\\/g, '/');
	const isDir = trimmed.endsWith('/');
	const parts = trimmed.split('/').filter((p) => p && p !== '.' && p !== '..');
	if (isDir) return { dirs: parts, file: null };
	const file = parts.pop() ?? null;
	return { dirs: parts, file };
}

export async function writeEntriesToDriver(
	driver: ExplorerDriver,
	parentId: string | null,
	files: PackedPath[],
	onFile?: (ev: ArchiveWriteProgress) => void,
	signal?: AbortSignal
): Promise<void> {
	const put = driver.writeFile ?? driver.upload;
	if (!put) throw new Error('This location cannot receive files');
	const flatten = !driver.mkdir || !driver.capabilities.supportsMkdir;
	const folderIds = new Map<string, string | null>([['', parentId]]);

	async function ensureDir(dirs: string[]): Promise<string | null> {
		if (!dirs.length) return parentId;
		if (flatten) return parentId;
		const key = dirs.join('/');
		const hit = folderIds.get(key);
		if (hit !== undefined) return hit;
		const parent = await ensureDir(dirs.slice(0, -1));
		const name = dirs[dirs.length - 1]!;
		const listed = await driver.list({ parentId: parent });
		const existing = listed.entries.find((e) => e.kind === 'folder' && e.name === name);
		if (existing) {
			folderIds.set(key, existing.id);
			return existing.id;
		}
		const created = await driver.mkdir!(parent, name);
		folderIds.set(key, created.id);
		return created.id;
	}

	for (const file of files) {
		throwIfAborted(signal);
		const { dirs, file: fileName } = splitPackedPath(file.path);
		if (!fileName) {
			if (dirs.length && !flatten) await ensureDir(dirs);
			continue;
		}
		const destParent = flatten ? parentId : await ensureDir(dirs);
		const destName = flatten && dirs.length ? `${dirs.join('__')}__${fileName}` : fileName;
		const copy = Uint8Array.from(file.data);
		const blob = new Blob([copy]);
		const size = blob.size;
		onFile?.({ name: destName, parentId: destParent, transferred: 0, size, done: false });
		const out = new File([blob], destName);
		if (typeof driver.upload === 'function') {
			await driver.upload(destParent, out, {
				signal,
				onProgress: (pct) => {
					const transferred = Math.round(size * Math.min(1, Math.max(0, pct)));
					onFile?.({ name: destName, parentId: destParent, transferred, size, done: false });
				}
			});
		} else {
			await driver.writeFile!(destParent, out);
		}
		onFile?.({ name: destName, parentId: destParent, transferred: size, size, done: true });
		await yieldPaint();
	}
}

export async function writeEntriesToVfs(
	vfs: VfsService,
	parentId: string | null,
	files: PackedPath[]
): Promise<void> {
	const folderIds = new Map<string, string | null>([['', parentId]]);

	async function ensureDir(dirs: string[]): Promise<string | null> {
		if (!dirs.length) return parentId;
		const key = dirs.join('/');
		const hit = folderIds.get(key);
		if (hit !== undefined) return hit;
		const parent = await ensureDir(dirs.slice(0, -1));
		const name = dirs[dirs.length - 1]!;
		const listed = await vfs.list({ parentId: parent });
		const existing = listed.find((e) => e.kind === 'folder' && e.name === name && !e.deletedAt);
		if (existing) {
			folderIds.set(key, existing.id);
			return existing.id;
		}
		const created = await vfs.mkdir(parent, name);
		folderIds.set(key, created.id);
		return created.id;
	}

	for (const file of files) {
		const { dirs, file: fileName } = splitPackedPath(file.path);
		if (!fileName) {
			if (dirs.length) await ensureDir(dirs);
			continue;
		}
		const destParent = await ensureDir(dirs);
		await vfs.writeFile({
			parentId: destParent,
			name: fileName,
			body: Uint8Array.from(file.data)
		});
	}
}

export type ExpandPackedOpts = {
	skipSystemFiles?: boolean;
	signal?: AbortSignal;
};

export async function expandPackedBytes(
	bytes: Uint8Array,
	name: string,
	password?: string,
	onMember?: (ev: { path: string; transferred: number; size: number; done: boolean }) => void,
	opts?: ExpandPackedOpts
): Promise<PackedPath[]> {
	const skipSystemFiles = opts?.skipSystemFiles !== false;
	const keep = (path: string) => !skipSystemFiles || !isJunkArchivePath(path);
	throwIfAborted(opts?.signal);
	if (isVaultBytes(bytes) || isVaultName(name)) {
		if (!password) throw new Error('Password is required');
		const opened = await openVault(bytes, password);
		const mapped = opened.entries
			.filter((e) => keep(e.path))
			.map((e) => ({ path: e.path, data: e.data }));
		for (const e of mapped) {
			onMember?.({
				path: e.path,
				transferred: e.data.byteLength,
				size: e.data.byteLength,
				done: true
			});
			await yieldPaint();
		}
		return mapped;
	}
	const fmt = detectFormat(bytes, name);
	if (!fmt) throw new Error(`Not a recognized archive: ${name}`);
	const engine = pickEngineForCodec(readStoredCompressEngine(), fmt.codec);
	const files = await expandBytes(engine, bytes, fmt.codec, name, {
		skipSystemFiles,
		onMember: (ev) => {
			onMember?.({
				path: ev.name,
				transferred: ev.transferred,
				size: ev.size ?? ev.transferred,
				done: ev.done
			});
		}
	});

	// Two-step expand: if we just decompressed a gzip/deflate/etc. layer
	// and the result is a single .tar file, automatically untar it.
	if (files.length === 1 && files[0]!.name.toLowerCase().endsWith('.tar')) {
		const tarBytes = files[0]!.data;
		const tarFmt = detectFormat(tarBytes, files[0]!.name);
		if (tarFmt?.codec === 'tar') {
			const tarEngine = pickEngineForCodec(readStoredCompressEngine(), 'tar');
			const tarFiles = await expandBytes(tarEngine, tarBytes, 'tar', files[0]!.name, {
				skipSystemFiles
			});
			return tarFiles.filter((f) => keep(f.name)).map((f) => ({ path: f.name, data: f.data }));
		}
	}

	return files.filter((f) => keep(f.name)).map((f) => ({ path: f.name, data: f.data }));
}

export function toArchiveEntries(files: PackedPath[]): ArchiveEntry[] {
	return files.map((f) => ({ name: f.path, data: f.data }));
}

export type ArchiveJobSpec = {
	kind: ArchiveKind;
	entries: ExplorerEntry[];
	driver: ExplorerDriver;
	dest: ArchiveDest;
	destParentId: string | null;
	title: string;
	/** Compress/encrypt output filename (zip / spvault). */
	outputName?: string;
	compressEngineId: CompressEngineId;
	codec: Codec;
	cryptoEngineId: CryptoEngineId;
	password: string;
	skipSystemFiles: boolean;
	useHost: boolean;
	hostOp?: 'zip' | 'tar' | 'tgz' | 'encrypt' | 'unzip' | 'untar' | 'decrypt';
	hostDestPath?: string;
	signal?: AbortSignal;
	onProgress?: (ev: ArchiveWriteProgress) => void;
};

export async function runArchiveJob(spec: ArchiveJobSpec): Promise<{
	inner?: PackedPath[];
	title: string;
}> {
	const {
		kind,
		entries,
		driver,
		dest,
		destParentId,
		title,
		signal,
		onProgress
	} = spec;
	throwIfAborted(signal);

	const emitJob = (transferred: number, size: number, done = false) => {
		onProgress?.({
			name: title,
			parentId: destParentId,
			transferred,
			size: Math.max(size, 1),
			done,
			job: true
		});
	};

	const writeOut = async (files: PackedPath[]) => {
		const total = files.reduce((n, f) => n + f.data.byteLength, 0) || 1;
		let finished = 0;
		const onFile = (ev: ArchiveWriteProgress) => {
			onProgress?.(ev);
			emitJob(finished + (ev.done ? ev.size : ev.transferred), total);
			if (ev.done) finished += ev.size;
		};
		if (dest === 'memory') {
			const mem = createMemoryExplorerDriver(getMemoryVfs());
			await mem.ready();
			await writeEntriesToDriver(mem, null, files, onFile, signal);
			return;
		}
		await writeEntriesToDriver(driver, destParentId, files, onFile, signal);
	};

	/** Browser dest filename from the dialog (zip / tar / vault only). */
	const namedOutput = (files: PackedPath[]): PackedPath[] => {
		const name = spec.outputName?.trim();
		if (!name || files.length !== 1) return files;
		if (kind === 'encrypt') return [{ path: name, data: files[0]!.data }];
		if (kind === 'compress' && (spec.codec === 'zip' || spec.codec === 'tar')) {
			return [{ path: name, data: files[0]!.data }];
		}
		return files;
	};

	if (spec.useHost) {
		if (!driver.archive) throw new Error('This connection cannot archive on the host');
		emitJob(0, 1);
		await driver.archive({
			op: spec.hostOp!,
			paths: entries.map((e) => driver.absolutePath!(e.id)),
			to: spec.hostDestPath!,
			password: kind === 'encrypt' || kind === 'decrypt' ? spec.password : undefined
		});
		throwIfAborted(signal);
		emitJob(1, 1, true);
		return { title };
	}

	if (kind === 'compress' || kind === 'encrypt') {
		emitJob(0, 4);
		const packed = await collectPackEntries(driver, entries, {
			signal,
			onFile: (n) => emitJob(n, Math.max(n + 2, 4))
		});
		throwIfAborted(signal);
		emitJob(packed.length + 1, packed.length + 3);
		if (kind === 'compress') {
			const out = await packFiles(spec.compressEngineId, toArchiveEntries(packed), spec.codec);
			throwIfAborted(signal);
			emitJob(packed.length + 2, packed.length + 3);
			await writeOut(namedOutput(out.map((f) => ({ path: f.name, data: f.data }))));
		} else {
			const sealed = await sealVault(
				spec.cryptoEngineId,
				packed,
				spec.password,
				packingAsTree(entries) ? { kind: 'tree' } : undefined
			);
			throwIfAborted(signal);
			emitJob(packed.length + 2, packed.length + 3);
			await writeOut(namedOutput([{ path: sealed.name, data: sealed.data }]));
		}
		emitJob(1, 1, true);
		return { title };
	}

	const inner: PackedPath[] = [];
	const sources = entries.filter((e) => e.kind === 'file');
	emitJob(0, Math.max(sources.length + 1, 1));
	let membersDone = 0;
	for (let i = 0; i < sources.length; i++) {
		throwIfAborted(signal);
		const entry = sources[i]!;
		const bytes = await readEntryBytes(driver, entry);
		inner.push(
			...(await expandPackedBytes(
				bytes,
				entry.name,
				spec.password,
				(ev) => {
					if (packedIsTopLevel(ev.path)) {
						onProgress?.({
							name: packedBasename(ev.path),
							parentId: destParentId,
							transferred: ev.transferred,
							size: ev.size || ev.transferred,
							done: ev.done
						});
					}
					if (ev.done) membersDone++;
					emitJob(membersDone, Math.max(membersDone + 1, sources.length + 1));
				},
				{ skipSystemFiles: spec.skipSystemFiles, signal }
			))
		);
		emitJob(i + 1, sources.length + 1);
	}
	if (!inner.length) throw new Error('Nothing to extract');
	if (dest === 'popup') return { inner, title };
	await writeOut(inner);
	emitJob(1, 1, true);
	return { title };
}

export async function createInnerFsSession(
	title: string,
	files: PackedPath[]
): Promise<InnerFsSession> {
	const vfs: VfsService = createVfs({
		dbName: `fe-inner-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
		memoryOpfs: true,
		requestPersist: false
	});
	await vfs.ready();
	await writeEntriesToVfs(vfs, null, files);
	const driver = createLocalExplorerDriver(vfs, {
		id: 'memory',
		capabilitiesPatch: {
			supportsDownload: true,
			supportsTrash: false,
			supportsSoftDelete: false
		}
	});
	let disposed = false;
	return {
		title,
		driver,
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			try {
				vfs.db.close();
				await vfs.db.delete();
			} catch {
				/* ignore */
			}
		}
	};
}
