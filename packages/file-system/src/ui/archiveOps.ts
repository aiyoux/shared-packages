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

	/** Mark one written file's bytes on its folder aggregate chain. */
	function bumpFolderAggs(dirs: string[], size: number) {
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

	// Resolve dest parents first (folders are memoized in `folderIds`), then
	// write. Same-parent members share vfs.writeFiles chunks: one reserve
	// txn + one confirm txn + one clear-pending txn per chunk instead of
	// three transactions per member, which dominated large extracts.
	type Planned = {
		dirs: string[];
		destParent: string | null;
		name: string;
		file: PackedPath;
	};
	const planned: Planned[] = [];
	for (const file of files) {
		throwIfAborted(signal);
		const { dirs, file: fileName } = splitPackedPath(file.path);
		if (!fileName) {
			if (dirs.length) await ensureDir(dirs);
			continue;
		}
		const destParent = await ensureDir(dirs);
		throwIfAborted(signal);
		planned.push({ dirs, destParent, name: fileName, file });
	}

	if (typeof driver.writeFiles === 'function') {
		const groups = new Map<string | null, Planned[]>();
		for (const plan of planned) {
			const group = groups.get(plan.destParent);
			if (group) group.push(plan);
			else groups.set(plan.destParent, [plan]);
		}
		for (const [destParent, group] of groups) {
			let done = 0;
			while (done < group.length) {
				throwIfAborted(signal);
				const batch = group.slice(done, done + 24);
				for (const plan of batch) {
					onFile?.({
						name: plan.name,
						parentId: destParent,
						transferred: 0,
						size: plan.file.data.byteLength,
						done: false,
						entryKind: 'file'
					});
				}
				// The File constructor snapshots bytes once per member, same as
				// the per-file path — no extra defensive copies.
				await driver.writeFiles(
					destParent,
					batch.map((plan) => new File([plan.file.data as BlobPart], plan.name)),
					{ signal }
				);
				throwIfAborted(signal);
				for (const plan of batch) {
					onFile?.({
						name: plan.name,
						parentId: destParent,
						transferred: plan.file.data.byteLength,
						size: plan.file.data.byteLength,
						done: true,
						entryKind: 'file'
					});
					if (plan.dirs.length) bumpFolderAggs(plan.dirs, plan.file.data.byteLength);
				}
				done += batch.length;
				await yieldPaint();
			}
		}
		return;
	}

	let written = 0;
	for (const plan of planned) {
		throwIfAborted(signal);
		const size = plan.file.data.byteLength;
		onFile?.({
			name: plan.name,
			parentId: plan.destParent,
			transferred: 0,
			size,
			done: false,
			entryKind: 'file'
		});
		// No defensive copy: the File constructor snapshots the bytes once, and
		// every extra copy doubled peak memory for large members.
		const out = new File([plan.file.data as BlobPart], plan.name);
		if (typeof driver.upload === 'function') {
			await driver.upload(plan.destParent, out, {
				signal,
				onProgress: (pct) => {
					if (signal?.aborted) return;
					const transferred = Math.round(size * Math.min(1, Math.max(0, pct)));
					onFile?.({
						name: plan.name,
						parentId: plan.destParent,
						transferred,
						size,
						done: false,
						entryKind: 'file'
					});
				}
			});
		} else {
			await driver.writeFile!(plan.destParent, out);
		}
		throwIfAborted(signal);
		onFile?.({
			name: plan.name,
			parentId: plan.destParent,
			transferred: size,
			size,
			done: true,
			entryKind: 'file'
		});
		bumpFolderAggs(plan.dirs, size);
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

	type Planned = { dirs: string[]; destParent: string | null; name: string; file: PackedPath };
	const planned: Planned[] = [];
	for (const file of files) {
		throwIfAborted(signal);
		const { dirs, file: fileName } = splitPackedPath(file.path);
		if (!fileName) {
			if (dirs.length) await ensureDir(dirs);
			continue;
		}
		const destParent = await ensureDir(dirs);
		planned.push({ dirs, destParent, name: fileName, file });
	}

	// Same-parent members share writeFiles chunks (popup dest = a fresh inner
	// VFS, so the per-file txn churn would dominate the whole job).
	const groups = new Map<string | null, Planned[]>();
	for (const plan of planned) {
		const group = groups.get(plan.destParent);
		if (group) group.push(plan);
		else groups.set(plan.destParent, [plan]);
	}
	for (const [destParent, group] of groups) {
		let done = 0;
		while (done < group.length) {
			throwIfAborted(signal);
			const batch = group.slice(done, done + 24);
			for (const plan of batch) {
				onFile?.({
					name: plan.name,
					parentId: destParent,
					transferred: 0,
					size: plan.file.data.byteLength,
					done: false
				});
			}
			await vfs.writeFiles(
				batch.map((plan) => ({
					parentId: destParent,
					name: plan.name,
					body: Uint8Array.from(plan.file.data)
				})),
				{ signal }
			);
			for (const plan of batch) {
				onFile?.({
					name: plan.name,
					parentId: destParent,
					transferred: plan.file.data.byteLength,
					size: plan.file.data.byteLength,
					done: true
				});
			}
			done += batch.length;
			await yieldPaint();
		}
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

	let lastJobPct = 0;
	const emitJobPct = (pct: number, done = false) => {
		const n = done ? 100 : Math.min(99, Math.max(0, Math.round(pct)));
		lastJobPct = n;
		emitJob(n, 100, done);
	};

	// Notes ride their own tick so labels set between fraction ticks (engine
	// chosen, member counts, unseal stages) still reach the chip/dialog.
	const setNote = (note: string) => {
		if (jobNote === note) return;
		jobNote = note;
		emitJob(lastJobPct, 100);
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

	const writeOut = async (files: PackedPath[], opts?: { listing?: boolean }) => {
		const listing = opts?.listing !== false;
		// The job fraction is byte-based — the same measure the dest listing
		// rows show — so the header can be read against them: identical for a
		// single output, the byte-weighted average for many. The old file-count
		// fraction read 40+ points ahead of the rows it sat next to.
		const totalBytes = Math.max(
			files
				.filter((f) => Boolean(packedBasename(f.path)) && !f.path.endsWith('/'))
				.reduce((n, f) => n + f.data.byteLength, 0),
			1
		);
		let doneBytes = 0;
		const onFile = (ev: ArchiveWriteProgress) => {
			if (listing) onProgress?.(ev);
			// Folder rows aggregate their children's bytes — counting them here
			// as well double-counts and pushed the job chip to 99% before the
			// last file was written. Only file rows advance the job fraction.
			if (ev.entryKind === 'folder') return;
			const frac = (doneBytes + Math.min(ev.transferred, ev.size)) / totalBytes;
			emitJobPct(Math.min(1, frac) * 100);
			if (ev.done) doneBytes += ev.size;
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

	// Phases each own the full 0–100 scale; the note names the phase, and a
	// phase without a byte-true signal (monolithic crypto, per-member counts)
	// stays at 0 — an indeterminate bar — instead of a fabricated fraction.
	// The write phase is the one where dest rows are visible, and its fraction
	// is the same byte measure they show.

	if (kind === 'compress' || kind === 'encrypt') {
		emitJobPct(0);
		const packed = await collectPackEntries(driver, entries, {
			signal,
			onFile: (n) => {
				// Collect ticks are label-only: no dest rows exist yet, and the
				// total is unknown until the walk finishes.
				setNote(`${n} file${n === 1 ? '' : 's'}…`);
			}
		});
		throwIfAborted(signal);
		if (kind === 'compress') {
			const role = describeCompressRole(spec.compressEngineId, spec.codec, 'create');
			remember(role, 'Compressing');
			const out = await packFiles(
				role.used as CompressEngineId,
				toArchiveEntries(packed),
				spec.codec
			);
			throwIfAborted(signal);
			setNote(
				role.fallback
					? `Writing with ${role.usedLabel} — ${role.reason}`
					: `Writing with ${role.usedLabel}…`
			);
			await writeOut(namedOutput(out.map((f) => ({ path: f.name, data: f.data }))));
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
			const sealed = await sealVault(
				spec.cryptoEngineId,
				packed,
				spec.password,
				packingAsTree(entries)
					? {
							kind: 'tree',
							// PBKDF2 + AES-GCM are monolithic — coarse stage ticks name
							// themselves in the note instead of a fabricated fraction.
							onProgress: (stage, total) => {
								setNote(`Encrypting with ${info.label} — stage ${stage} of ${total}…`);
							}
						}
					: undefined
			);
			throwIfAborted(signal);
			setNote(`Writing with ${info.label}…`);
			await writeOut(namedOutput([{ path: sealed.name, data: sealed.data }]));
		}
		emitJobPct(100, true);
		return { title, engines };
	}

	const inner: PackedPath[] = [];
	const sources = entries.filter((e) => e.kind === 'file');
	emitJobPct(0);
	let membersDone = 0;
	let expandEngineLabel = '';
	const expandVerb = kind === 'decrypt' ? 'Decrypting' : 'Decompressing';
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
					// Expand ticks are label-only member counts: no dest rows exist
					// yet (writeOut paints those), and member sizes are not known in
					// advance, so a per-member count is the honest signal.
					if (ev.done) membersDone++;
					if (membersDone > 0) {
						setNote(
							expandEngineLabel
								? `${expandVerb} with ${expandEngineLabel} — ${membersDone} file${
										membersDone === 1 ? '' : 's'
									}…`
								: `${membersDone} file${membersDone === 1 ? '' : 's'}…`
						);
					}
				},
				{
					skipSystemFiles: spec.skipSystemFiles,
					signal,
					compressEngineId: spec.compressEngineId,
					onVaultProgress: (stage, total) => {
						// Unseal is the whole expand phase for a decrypt — coarse
						// stages name themselves instead of a fabricated fraction.
						setNote(`Unsealing vault — stage ${stage} of ${total}…`);
					},
					onEngine: (role) => {
						remember(role, expandVerb);
						expandEngineLabel = role.usedLabel;
					}
				}
			))
		);
	}
	if (!inner.length) throw new Error('Nothing to extract');
	if (dest === 'popup') {
		setNote('Writing extracted files…');
		// Same byte-based fraction as writeOut — the inner session's rows and
		// the header read against each other.
		const totalBytes = Math.max(
			inner
				.filter((f) => Boolean(packedBasename(f.path)) && !f.path.endsWith('/'))
				.reduce((n, f) => n + f.data.byteLength, 0),
			1
		);
		let doneBytes = 0;
		const innerSession = await createInnerFsSession(
			title,
			inner,
			(ev) => {
				if (ev.entryKind === 'folder') return;
				const frac = (doneBytes + Math.min(ev.transferred, ev.size)) / totalBytes;
				emitJobPct(Math.min(1, frac) * 100);
				if (ev.done) doneBytes += ev.size;
			},
			signal
		);
		emitJobPct(100, true);
		return { inner, innerSession, title, engines };
	}
	setNote('Writing extracted files…');
	let toWrite = inner;
	const wrapDest = dest === 'same' || dest === 'folder';
	if (spec.wrapInSubfolder && wrapDest && driver.mkdir) {
		throwIfAborted(signal);
		const stem = extractContainerName(sources[0]?.name ?? title);
		const folder = await uniqueChildFolderName(driver, destParentId, stem);
		toWrite = prefixPackedPaths(inner, folder);
	}
	await writeOut(toWrite);
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
