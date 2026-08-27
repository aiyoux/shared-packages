/**
 * Pack / unpack FileExplorer rows via @shared-packages/compress and crypto.
 * Used by FeArchiveDialog and the inner-filesystem popup.
 */
import {
	CODEC_LABEL,
	ENGINE_CATALOG,
	DEFAULT_ENGINE as DEFAULT_COMPRESS_ENGINE,
	detectFormat,
	detectFormatFromName,
	engineInfo as compressEngineInfo,
	stripCompressionExt,
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
	engineInfo as cryptoEngineInfo,
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
	/** Chip / dialog label — which library is running, including fallbacks. */
	note?: string;
	/** Folder rows aggregate descendant writes. Default file. */
	entryKind?: 'file' | 'folder';
};

/** Selected library vs the one that actually ran (or will run). */
export type EngineRole = {
	kind: 'compress' | 'crypto';
	action: 'create' | 'expand' | 'seal' | 'open';
	requested?: string;
	requestedLabel?: string;
	used: string;
	usedLabel: string;
	fallback: boolean;
	reason?: string;
};

export type ArchiveEnginePlan = {
	fallback: boolean;
	lines: string[];
	roles: EngineRole[];
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

/** Folder name for “extract into a subfolder named after the archive”. */
export function extractContainerName(archiveName: string): string {
	const base = packedBasename(archiveName);
	if (isVaultName(base)) {
		return base.slice(0, -'.spvault'.length) || 'vault';
	}
	const fmt = detectFormatFromName(base);
	if (fmt) {
		let stem = stripCompressionExt(base, fmt.codec);
		if (stem.toLowerCase().endsWith('.tar')) stem = stem.slice(0, -4) || stem;
		return packedBasename(stem) || 'archive';
	}
	const dot = base.lastIndexOf('.');
	if (dot > 0) return base.slice(0, dot);
	return base || 'archive';
}

export async function uniqueChildFolderName(
	driver: ExplorerDriver,
	parentId: string | null,
	base: string
): Promise<string> {
	const clean = base.trim() || 'archive';
	if (!driver.list) return clean;
	const listed = await driver.list({ parentId });
	const taken = new Set(listed.entries.map((e) => e.name.toLowerCase()));
	if (!taken.has(clean.toLowerCase())) return clean;
	for (let i = 1; i < 1000; i++) {
		const name = `${clean} (${i})`;
		if (!taken.has(name.toLowerCase())) return name;
	}
	return `${clean} (${Date.now()})`;
}

function prefixPackedPaths(files: PackedPath[], folder: string): PackedPath[] {
	return files.map((f) => {
		const rel = f.path.replace(/^\/+/, '');
		return { path: rel ? `${folder}/${rel}` : `${folder}/`, data: f.data };
	});
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

export function describeCompressRole(
	preferred: CompressEngineId,
	codec: Codec,
	action: 'create' | 'expand'
): EngineRole {
	const requestedLabel = compressEngineInfo(preferred).label;
	if (engineSupports(preferred, codec)) {
		return {
			kind: 'compress',
			action,
			requested: preferred,
			requestedLabel,
			used: preferred,
			usedLabel: requestedLabel,
			fallback: false
		};
	}
	const found = ENGINE_CATALOG.find((e) => e.codecs.includes(codec));
	if (!found) throw new Error(`No installed library can ${action} ${CODEC_LABEL[codec]}`);
	return {
		kind: 'compress',
		action,
		requested: preferred,
		requestedLabel,
		used: found.id,
		usedLabel: found.label,
		fallback: true,
		reason: `${requestedLabel} cannot ${action} ${CODEC_LABEL[codec]}`
	};
}

export function pickEngineForCodec(
	preferred: CompressEngineId,
	codec: Codec
): CompressEngineId {
	return describeCompressRole(preferred, codec, 'expand').used as CompressEngineId;
}

export function formatEngineNote(role: EngineRole, verb: string): string {
	if (role.fallback && role.reason) return `${verb} with ${role.usedLabel} — ${role.reason}`;
	return `${verb} with ${role.usedLabel}`;
}

function looksTarGzName(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.endsWith('.tar.gz') || lower.endsWith('.tgz');
}

export function previewArchiveEnginePlan(args: {
	kind: ArchiveKind;
	entries: ExplorerEntry[];
	compressEngineId: CompressEngineId;
	codec: Codec;
	cryptoEngineId: CryptoEngineId;
	useHost: boolean;
}): ArchiveEnginePlan {
	if (args.useHost) {
		return {
			fallback: false,
			roles: [],
			lines: ['This job runs on the monitor computer, not a browser library.']
		};
	}
	if (args.kind === 'encrypt') {
		const info = cryptoEngineInfo(args.cryptoEngineId);
		const role: EngineRole = {
			kind: 'crypto',
			action: 'seal',
			requested: args.cryptoEngineId,
			requestedLabel: info.label,
			used: args.cryptoEngineId,
			usedLabel: info.label,
			fallback: false
		};
		return {
			fallback: false,
			roles: [role],
			lines: [`This job will use ${info.label} (${info.aead}).`]
		};
	}
	if (args.kind === 'decrypt') {
		return {
			fallback: false,
			roles: [],
			lines: [
				'This job will use the library recorded in the vault (Web Crypto or libsodium). Encrypt wrote that into the header — it is not a choice here.'
			]
		};
	}
	if (args.kind === 'compress') {
		const role = describeCompressRole(args.compressEngineId, args.codec, 'create');
		if (role.fallback) {
			return {
				fallback: true,
				roles: [role],
				lines: [
					`Selected ${role.requestedLabel} cannot create ${CODEC_LABEL[args.codec]}. This job will use ${role.usedLabel}.`
				]
			};
		}
		return {
			fallback: false,
			roles: [role],
			lines: [`This job will use ${role.usedLabel}.`]
		};
	}
	const names = args.entries.filter((e) => e.kind === 'file').map((e) => e.name);
	const fmt = names[0] ? detectFormatFromName(names[0]!) : null;
	if (!fmt) {
		const label = compressEngineInfo(args.compressEngineId).label;
		return {
			fallback: false,
			roles: [],
			lines: [
				`Format is detected from each file. If ${label} cannot expand it, another installed library will be used.`
			]
		};
	}
	const role = describeCompressRole(args.compressEngineId, fmt.codec, 'expand');
	const roles: EngineRole[] = [role];
	const lines: string[] = [];
	if (role.fallback) {
		lines.push(
			`This looks like ${CODEC_LABEL[fmt.codec]}. Selected ${role.requestedLabel} cannot expand it — this job will use ${role.usedLabel}.`
		);
	} else {
		lines.push(`This looks like ${CODEC_LABEL[fmt.codec]}. This job will use ${role.usedLabel}.`);
	}
	if (names.some(looksTarGzName)) {
		const tar = describeCompressRole(args.compressEngineId, 'tar', 'expand');
		roles.push(tar);
		if (tar.fallback) {
			lines.push(
				`After gzip, the inner TAR will use ${tar.usedLabel} (${role.usedLabel} cannot expand TAR).`
			);
		} else {
			lines.push('After gzip, the inner TAR is expanded with the same library.');
		}
	}
	return { fallback: roles.some((r) => r.fallback), roles, lines };
}

export function archiveJobPhaseLabel(spec: {
	kind: ArchiveKind;
	entries: ExplorerEntry[];
	compressEngineId: CompressEngineId;
	codec: Codec;
	cryptoEngineId: CryptoEngineId;
	useHost: boolean;
}): string {
	const plan = previewArchiveEnginePlan(spec);
	if (spec.useHost) {
		return spec.kind === 'compress'
			? 'Zipping on this computer…'
			: spec.kind === 'encrypt'
				? 'Encrypting on this computer…'
				: spec.kind === 'decompress'
					? 'Extracting on this computer…'
					: 'Decrypting on this computer…';
	}
	const role = plan.roles[0];
	const verb =
		spec.kind === 'compress'
			? 'Compressing'
			: spec.kind === 'encrypt'
				? 'Encrypting'
				: spec.kind === 'decompress'
					? 'Decompressing'
					: 'Decrypting';
	if (role) return formatEngineNote(role, verb);
	if (spec.kind === 'decrypt') return 'Decrypting with the vault’s recorded library…';
	return `${verb}…`;
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
	// Same contract as dropping/picking folders in (osDrop.ts): never silently
	// flatten a nested tree into dir__file names on a driver that cannot mkdir.
	const nested = files.some((f) => splitPackedPath(f.path).dirs.length > 0);
	if (nested && (!driver.mkdir || !driver.capabilities.supportsMkdir)) {
		throw new Error(
			'This connection cannot create folders. Extract individual files instead, or pick another location.'
		);
	}
	const folderIds = new Map<string, string | null>([['', parentId]]);

	type FolderAgg = {
		name: string;
		parentKey: string;
		totalBytes: number;
		totalFiles: number;
		doneBytes: number;
		doneFiles: number;
	};
	const folderAgg = new Map<string, FolderAgg>();
	for (const file of files) {
		const { dirs, file: fileName } = splitPackedPath(file.path);
		if (!fileName) continue;
		let parentKey = '';
		for (const seg of dirs) {
			const key = parentKey ? `${parentKey}/${seg}` : seg;
			let agg = folderAgg.get(key);
			if (!agg) {
				agg = {
					name: seg,
					parentKey,
					totalBytes: 0,
					totalFiles: 0,
					doneBytes: 0,
					doneFiles: 0
				};
				folderAgg.set(key, agg);
			}
			agg.totalBytes += file.data.byteLength;
			agg.totalFiles += 1;
			parentKey = key;
		}
	}

	function emitFolder(relKey: string) {
		const agg = folderAgg.get(relKey);
		if (!agg) return;
		const destParent = folderIds.get(agg.parentKey);
		if (destParent === undefined) return;
		onFile?.({
			name: agg.name,
			parentId: destParent,
			transferred: agg.doneBytes,
			size: Math.max(agg.totalBytes, 1),
			done: agg.totalFiles > 0 && agg.doneFiles >= agg.totalFiles,
			entryKind: 'folder'
		});
	}

	async function ensureDir(dirs: string[]): Promise<string | null> {
		if (!dirs.length) return parentId;
		const key = dirs.join('/');
		const hit = folderIds.get(key);
		if (hit !== undefined) return hit;
		throwIfAborted(signal);
		const parent = await ensureDir(dirs.slice(0, -1));
		throwIfAborted(signal);
		const name = dirs[dirs.length - 1]!;
		const listed = await driver.list({ parentId: parent });
		throwIfAborted(signal);
		const existing = listed.entries.find((e) => e.kind === 'folder' && e.name === name);
		if (existing) {
			folderIds.set(key, existing.id);
			emitFolder(key);
			return existing.id;
		}
		const created = await driver.mkdir!(parent, name);
		folderIds.set(key, created.id);
		emitFolder(key);
		return created.id;
	}

	for (const [key, agg] of folderAgg) {
		if (agg.parentKey === '') emitFolder(key);
	}

	let written = 0;
	for (const file of files) {
		throwIfAborted(signal);
		const { dirs, file: fileName } = splitPackedPath(file.path);
		if (!fileName) {
			if (dirs.length) await ensureDir(dirs);
			continue;
		}
		const destParent = await ensureDir(dirs);
		throwIfAborted(signal);
		const destName = fileName;
		const size = file.data.byteLength;
		onFile?.({
			name: destName,
			parentId: destParent,
			transferred: 0,
			size,
			done: false,
			entryKind: 'file'
		});
		// No defensive copy: the File constructor snapshots the bytes once, and
		// every extra copy doubled peak memory for large members.
		const out = new File([file.data as BlobPart], destName);
		if (typeof driver.upload === 'function') {
			await driver.upload(destParent, out, {
				signal,
				onProgress: (pct) => {
					if (signal?.aborted) return;
					const transferred = Math.round(size * Math.min(1, Math.max(0, pct)));
					onFile?.({
						name: destName,
						parentId: destParent,
						transferred,
						size,
						done: false,
						entryKind: 'file'
					});
				}
			});
		} else {
			await driver.writeFile!(destParent, out);
		}
		throwIfAborted(signal);
		onFile?.({
			name: destName,
			parentId: destParent,
			transferred: size,
			size,
			done: true,
			entryKind: 'file'
		});
		if (dirs.length) {
			let parentKey = '';
			for (const seg of dirs) {
				const key = parentKey ? `${parentKey}/${seg}` : seg;
				const agg = folderAgg.get(key);
				if (agg) {
					agg.doneBytes += size;
					agg.doneFiles += 1;
					emitFolder(key);
				}
				parentKey = key;
			}
		}
		written += 1;
		if ((written & 7) === 0) await yieldPaint();
	}
}

export async function writeEntriesToVfs(
	vfs: VfsService,
	parentId: string | null,
	files: PackedPath[],
	onFile?: (ev: ArchiveWriteProgress) => void,
	signal?: AbortSignal
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
		throwIfAborted(signal);
		const { dirs, file: fileName } = splitPackedPath(file.path);
		if (!fileName) {
			if (dirs.length) await ensureDir(dirs);
			continue;
		}
		const destParent = await ensureDir(dirs);
		const size = file.data.byteLength;
		onFile?.({ name: fileName, parentId: destParent, transferred: 0, size, done: false });
		await vfs.writeFile({
			parentId: destParent,
			name: fileName,
			body: Uint8Array.from(file.data)
		});
		onFile?.({ name: fileName, parentId: destParent, transferred: size, size, done: true });
	}
}

export type ExpandPackedOpts = {
	skipSystemFiles?: boolean;
	signal?: AbortSignal;
	/** Preferred compress library. Falls back to a catalog engine that supports the codec. */
	compressEngineId?: CompressEngineId;
	onEngine?: (role: EngineRole) => void;
	/** Vault (decrypt) stage ticks while unsealing — monolithic, not byte-granular. */
	onVaultProgress?: (stage: number, total: number) => void;
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
	const preferred = opts?.compressEngineId ?? readStoredCompressEngine();
	throwIfAborted(opts?.signal);
	if (isVaultBytes(bytes) || isVaultName(name)) {
		if (!password) throw new Error('Password is required');
		const opened = await openVault(bytes, password, {
			onProgress: opts?.onVaultProgress
		});
		const info = cryptoEngineInfo(opened.engine);
		opts?.onEngine?.({
			kind: 'crypto',
			action: 'open',
			used: opened.engine,
			usedLabel: info.label,
			fallback: false,
			reason: 'Recorded in the vault header'
		});
		const mapped = opened.entries
			.filter((e) => keep(e.path))
			.map((e) => ({ path: e.path, data: e.data }));
		for (const e of mapped) {
			throwIfAborted(opts?.signal);
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
	const role = describeCompressRole(preferred, fmt.codec, 'expand');
	opts?.onEngine?.(role);
	const files = await expandBytes(role.used as CompressEngineId, bytes, fmt.codec, name, {
		skipSystemFiles,
		signal: opts?.signal,
		onMember: (ev) => {
			throwIfAborted(opts?.signal);
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
			const tarRole = describeCompressRole(preferred, 'tar', 'expand');
			opts?.onEngine?.(tarRole);
			const tarFiles = await expandBytes(
				tarRole.used as CompressEngineId,
				tarBytes,
				'tar',
				files[0]!.name,
				{
					skipSystemFiles,
					signal: opts?.signal,
					onMember: (ev) => {
						throwIfAborted(opts?.signal);
						onMember?.({
							path: ev.name,
							transferred: ev.transferred,
							size: ev.size ?? ev.transferred,
							done: ev.done
						});
					}
				}
			);
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
	/** Extract into a new folder named after the archive. Dialog default is on. */
	wrapInSubfolder?: boolean;
	useHost: boolean;
	hostOp?: 'zip' | 'tar' | 'tgz' | 'encrypt' | 'unzip' | 'untar' | 'decrypt';
	hostDestPath?: string;
	signal?: AbortSignal;
	onProgress?: (ev: ArchiveWriteProgress) => void;
};

export type ArchiveJobResult = {
	inner?: PackedPath[];
	innerSession?: InnerFsSession;
	title: string;
	engines: EngineRole[];
};

export async function runArchiveJob(spec: ArchiveJobSpec): Promise<ArchiveJobResult> {
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

	const engines: EngineRole[] = [];
	let jobNote = archiveJobPhaseLabel(spec);

	const emitJob = (transferred: number, size: number, done = false) => {
		onProgress?.({
			name: title,
			parentId: destParentId,
			transferred,
			size: Math.max(size, 1),
			done,
			job: true,
			note: jobNote
		});
	};

	const emitJobPct = (pct: number, done = false) => {
		const n = done ? 100 : Math.min(99, Math.max(0, Math.round(pct)));
		emitJob(n, 100, done);
	};

	const setNote = (note: string) => {
		jobNote = note;
	};

	const remember = (role: EngineRole, verb: string) => {
		if (
			!engines.some(
				(e) => e.used === role.used && e.action === role.action && e.fallback === role.fallback
			)
		) {
			engines.push(role);
		}
		setNote(formatEngineNote(role, verb));
	};

	const writeOut = async (
		files: PackedPath[],
		writeFromPct: number,
		opts?: { listing?: boolean }
	) => {
		const listing = opts?.listing !== false;
		const totalFiles = Math.max(
			files.filter((f) => Boolean(packedBasename(f.path)) && !f.path.endsWith('/')).length,
			1
		);
		let filesDone = 0;
		const onFile = (ev: ArchiveWriteProgress) => {
			if (listing) onProgress?.(ev);
			// Folder rows aggregate their children's bytes — counting them here
			// as well double-counts and pushed the job chip to 99% before the
			// last file was written. Only file rows advance the job fraction.
			if (ev.entryKind === 'folder') return;
			const frac = ev.done
				? (filesDone + 1) / totalFiles
				: (filesDone + (ev.size ? ev.transferred / ev.size : 0)) / totalFiles;
			emitJobPct(writeFromPct + (100 - writeFromPct) * Math.min(1, frac));
			if (ev.done) filesDone += 1;
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
		emitJobPct(0);
		await driver.archive(
			{
				op: spec.hostOp!,
				paths: entries.map((e) => driver.absolutePath!(e.id)),
				to: spec.hostDestPath!,
				password: kind === 'encrypt' || kind === 'decrypt' ? spec.password : undefined
			},
			{
				signal,
				onProgress: (transferred, size) => {
					if (signal?.aborted) return;
					// The daemon streams (transferred, total); emitJobPct caps at 99
					// until the awaited result confirms completion.
					emitJobPct((transferred / Math.max(size ?? 0, 1)) * 100);
				}
			}
		);
		throwIfAborted(signal);
		emitJobPct(100, true);
		return { title, engines };
	}

	const COLLECT_PCT = 30;
	const PACK_PCT = 40;

	if (kind === 'compress' || kind === 'encrypt') {
		emitJobPct(0);
		const packed = await collectPackEntries(driver, entries, {
			signal,
			onFile: (n) => {
				emitJobPct((n / Math.max(n + 1, 1)) * COLLECT_PCT);
			}
		});
		throwIfAborted(signal);
		emitJobPct(COLLECT_PCT);
		if (kind === 'compress') {
			const role = describeCompressRole(spec.compressEngineId, spec.codec, 'create');
			remember(role, 'Compressing');
			emitJobPct(COLLECT_PCT);
			const out = await packFiles(
				role.used as CompressEngineId,
				toArchiveEntries(packed),
				spec.codec
			);
			throwIfAborted(signal);
			emitJobPct(PACK_PCT);
			setNote(
				role.fallback
					? `Writing with ${role.usedLabel} — ${role.reason}`
					: `Writing with ${role.usedLabel}…`
			);
			await writeOut(
				namedOutput(out.map((f) => ({ path: f.name, data: f.data }))),
				PACK_PCT
			);
		} else {
			const info = cryptoEngineInfo(spec.cryptoEngineId);
			remember(
				{
					kind: 'crypto',
					action: 'seal',
					requested: spec.cryptoEngineId,
					requestedLabel: info.label,
					used: spec.cryptoEngineId,
					usedLabel: info.label,
					fallback: false
				},
				'Encrypting'
			);
			emitJobPct(COLLECT_PCT);
			const sealed = await sealVault(
				spec.cryptoEngineId,
				packed,
				spec.password,
				packingAsTree(entries)
					? {
							kind: 'tree',
							// PBKDF2 + AES-GCM are monolithic — stage ticks spread across
							// the collect→pack window so the chip is not dead air.
							onProgress: (stage, total) => {
								emitJobPct(COLLECT_PCT + (PACK_PCT - COLLECT_PCT) * (stage / total));
							}
						}
					: undefined
			);
			throwIfAborted(signal);
			emitJobPct(PACK_PCT);
			setNote(`Writing with ${info.label}…`);
			await writeOut(namedOutput([{ path: sealed.name, data: sealed.data }]), PACK_PCT);
		}
		emitJobPct(100, true);
		return { title, engines };
	}

	const inner: PackedPath[] = [];
	const sources = entries.filter((e) => e.kind === 'file');
	const EXPAND_PCT = 40;
	emitJobPct(0);
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
					// Expand ticks are chip-only. Dest listing bars come from writeOut
					// so nested members are not marked 100% before they hit disk.
					if (ev.done) membersDone++;
					emitJobPct((membersDone / Math.max(membersDone + 1, 1)) * EXPAND_PCT);
				},
				{
					skipSystemFiles: spec.skipSystemFiles,
					signal,
					compressEngineId: spec.compressEngineId,
					onVaultProgress: (stage, total) => {
						// Unseal is the whole expand phase for a decrypt — spread its
						// stage ticks across the expand window.
						emitJobPct((stage / total) * EXPAND_PCT);
					},
					onEngine: (role) => {
						remember(
							role,
							kind === 'decrypt' ? 'Decrypting' : 'Decompressing'
						);
					}
				}
			))
		);
		emitJobPct(((i + 1) / Math.max(sources.length, 1)) * EXPAND_PCT);
	}
	if (!inner.length) throw new Error('Nothing to extract');
	if (dest === 'popup') {
		emitJobPct(EXPAND_PCT);
		setNote('Writing extracted files…');
		emitJobPct(EXPAND_PCT);
		const totalFiles = Math.max(
			inner.filter((f) => Boolean(packedBasename(f.path)) && !f.path.endsWith('/')).length,
			1
		);
		let filesDone = 0;
		const innerSession = await createInnerFsSession(
			title,
			inner,
			(ev) => {
				const frac = ev.done
					? (filesDone + 1) / totalFiles
					: (filesDone + (ev.size ? ev.transferred / ev.size : 0)) / totalFiles;
				emitJobPct(EXPAND_PCT + (100 - EXPAND_PCT) * Math.min(1, frac));
				if (ev.done) filesDone += 1;
			},
			signal
		);
		emitJobPct(100, true);
		return { inner, innerSession, title, engines };
	}
	emitJobPct(EXPAND_PCT);
	setNote('Writing extracted files…');
	emitJobPct(EXPAND_PCT);
	let toWrite = inner;
	const wrapDest = dest === 'same' || dest === 'folder';
	if (spec.wrapInSubfolder && wrapDest && driver.mkdir) {
		throwIfAborted(signal);
		const stem = extractContainerName(sources[0]?.name ?? title);
		const folder = await uniqueChildFolderName(driver, destParentId, stem);
		toWrite = prefixPackedPaths(inner, folder);
	}
	await writeOut(toWrite, EXPAND_PCT);
	emitJobPct(100, true);
	return { title, engines };
}

export async function createInnerFsSession(
	title: string,
	files: PackedPath[],
	onFile?: (ev: ArchiveWriteProgress) => void,
	signal?: AbortSignal
): Promise<InnerFsSession> {
	const vfs: VfsService = createVfs({
		dbName: `fe-inner-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
		memoryOpfs: true,
		requestPersist: false
	});
	try {
		await vfs.ready();
		await writeEntriesToVfs(vfs, null, files, onFile, signal);
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
	} catch (e) {
		try {
			vfs.db.close();
			await vfs.db.delete();
		} catch {
			/* ignore */
		}
		throw e;
	}
}
