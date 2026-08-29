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
	loadEngine as loadCompressEngine,
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

/**
 * Instantiate the engines an expand will need, before the job starts.
 *
 * WASM instantiation is the single most expensive thing in the whole matrix
 * and it is a ONE-TIME cost: `loadEngine('addmaple')` measured ~8s cold
 * (fetch + compile + instantiate for three modules) while the codec calls
 * themselves are milliseconds and never block a frame once warm. Doing it
 * while the user is still reading a dialog — or hovering a file — takes that
 * cost off the job entirely.
 *
 * Fire-and-forget: a failed prewarm is not an error (the real load inside the
 * job reports properly), so every rejection is swallowed here.
 */
export function prewarmExpandEngines(
	names: string[],
	preferred: CompressEngineId = readStoredCompressEngine()
): void {
	for (const engine of enginesToPrewarm(names, preferred)) {
		void loadCompressEngine(engine).catch(() => {
			/* prewarm is best-effort */
		});
	}
}

/** Which libraries `prewarmExpandEngines` would instantiate. Pure; testable. */
export function enginesToPrewarm(
	names: string[],
	preferred: CompressEngineId
): CompressEngineId[] {
	const codecs = new Set<Codec>();
	for (const name of names) {
		// Vaults are opened by the crypto engine recorded in their header, so
		// no compress library is involved.
		if (isVaultName(name)) continue;
		const fmt = detectFormatFromName(name);
		if (fmt) codecs.add(fmt.codec);
		// `.tar.gz` / `.tgz` expand in two stages, and the inner TAR may need a
		// different library than the outer gzip — warm both.
		if (looksTarGzName(name)) codecs.add('tar');
	}
	const engines = new Set<CompressEngineId>();
	for (const codec of codecs) {
		try {
			engines.add(pickEngineForCodec(preferred, codec));
		} catch {
			// No installed library handles it; the job itself reports that.
		}
	}
	return [...engines];
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

/**
 * Write members to a driver AS THEY ARRIVE, instead of after the whole archive
 * is expanded.
 *
 * Pipelining turns a job's wall clock from `inflate + write` into roughly
 * `max(inflate, write)`, and — more importantly — bounds peak memory: only the
 * current window is held, not every member of the archive at once.
 *
 * Members accumulate into a window and flush together, because the batched
 * dest write is far cheaper per file than one write per member. `push` awaits
 * the flush, so a slow disk throttles the expander rather than queueing behind
 * it (that backpressure is what makes the memory bound real).
 *
 * Folder aggregate rows can only report what has arrived so far — a stream
 * does not know an archive's folder totals up front — so they stay
 * indeterminate until `finish` confirms the job.
 */
export function createStreamingWriter(opts: {
	driver: ExplorerDriver;
	parentId: string | null;
	onFile?: (ev: ArchiveWriteProgress) => void;
	signal?: AbortSignal;
	/** Opt into shared-pack storage for these writes (Projects only). */
	pack?: boolean;
	/** Members per flush. Matches the vfs bulk-write chunk. */
	windowFiles?: number;
	/** Bytes per flush; whichever cap trips first wins. */
	windowBytes?: number;
}): {
	push: (entry: PackedPath) => Promise<void>;
	finish: () => Promise<number>;
} {
	const { driver, parentId, onFile, signal } = opts;
	// The window is what the pipeline holds in memory before handing a batch to
	// the dest. It must not be SMALLER than the store's own chunk size or it
	// re-caps the write path from above: at 24 the extract path never saw the
	// raised cap and paid ~60% more OPFS round trips than the bulk path.
	// Bytes are the real governor; the file count is a backstop for tiny members.
	const windowFiles = opts.windowFiles ?? 512;
	const windowBytes = opts.windowBytes ?? 64 << 20;
	const put = driver.writeFile ?? driver.upload;
	if (!put) throw new Error('This location cannot receive files');
	// ONE folder context for the whole stream. Rebuilding it per flush cost a
	// driver.list() per directory per batch — at 3000 files across ~125
	// flushes that dominated the job.
	const folders = createDestFolders(driver, parentId, signal);

	let window: PackedPath[] = [];
	let windowSize = 0;
	let written = 0;
	let checkedNesting = false;

	const flush = async () => {
		if (!window.length) return;
		const batch = window;
		window = [];
		windowSize = 0;
		throwIfAborted(signal);
		await writeEntriesToDriver(driver, parentId, batch, onFile, signal, folders, opts.pack);
		written += batch.length;
	};

	return {
		async push(entry) {
			throwIfAborted(signal);
			// Same contract as the buffered path: never silently flatten a nested
			// tree onto a driver that cannot mkdir. Checked on the first nested
			// member, since a stream has no up-front view of the whole archive.
			if (!checkedNesting && splitPackedPath(entry.path).dirs.length > 0) {
				checkedNesting = true;
				if (!driver.mkdir || !driver.capabilities.supportsMkdir) {
					throw new Error(
						'This connection cannot create folders. Extract individual files instead, or pick another location.'
					);
				}
			}
			window.push(entry);
			windowSize += entry.data.byteLength;
			if (window.length >= windowFiles || windowSize >= windowBytes) await flush();
		},
		async finish() {
			await flush();
			return written;
		}
	};
}

/**
 * Destination folder resolution shared across writes.
 *
 * `ensureDir` memoizes every folder it resolves or creates. A streaming writer
 * keeps ONE of these for the whole job: rebuilding it per flush meant a
 * `driver.list()` per directory per batch, which is most of why a 3000-file
 * extract crawled — the folder lookups, not the bytes.
 */
export type DestFolders = {
	ensureDir: (dirs: string[]) => Promise<string | null>;
	/** Folder rows already painted, so a re-flush does not repaint them. */
	painted: Set<string>;
};

export function createDestFolders(
	driver: ExplorerDriver,
	parentId: string | null,
	signal?: AbortSignal
): DestFolders {
	const folderIds = new Map<string, string | null>([['', parentId]]);
	const painted = new Set<string>();

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
			return existing.id;
		}
		const created = await driver.mkdir!(parent, name);
		folderIds.set(key, created.id);
		return created.id;
	}

	return { ensureDir, painted };
}

export async function writeEntriesToDriver(
	driver: ExplorerDriver,
	parentId: string | null,
	files: PackedPath[],
	onFile?: (ev: ArchiveWriteProgress) => void,
	signal?: AbortSignal,
	/** Reused across flushes by a streaming writer; created per call otherwise. */
	folders?: DestFolders,
	/** Shared-pack storage for these members (Projects only). */
	pack?: boolean
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
	const dest = folders ?? createDestFolders(driver, parentId, signal);
	const ensureDir = dest.ensureDir;

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

	const folderParents = new Map<string, string | null>();

	function emitFolder(relKey: string) {
		const agg = folderAgg.get(relKey);
		if (!agg) return;
		const destParent = folderParents.get(relKey);
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
		// Folder rows need the dest id of each ancestor's PARENT; resolving the
		// chain here reuses ensureDir's cache instead of listing again.
		let parentKey = '';
		for (let d = 0; d < dirs.length; d++) {
			const key = dirs.slice(0, d + 1).join('/');
			if (!folderParents.has(key)) {
				folderParents.set(key, await ensureDir(dirs.slice(0, d)));
			}
			parentKey = key;
		}
		void parentKey;
		planned.push({ dirs, destParent, name: fileName, file });
	}

	// Paint top-level folder rows once their dest parent is known.
	for (const [key, agg] of folderAgg) {
		if (agg.parentKey === '' && !dest.painted.has(key)) {
			dest.painted.add(key);
			emitFolder(key);
		}
	}

	// One batch across every destination folder, when the driver can do it.
	// Grouping by folder below is only a limitation of `writeFiles`, which takes
	// a single parentId — and a pack is formed per call, so a wide archive was
	// producing one pack per directory instead of one per chunk.
	if (pack && typeof driver.writeFilesAcross === 'function' && planned.length) {
		throwIfAborted(signal);
		for (const plan of planned) {
			onFile?.({
				name: plan.name,
				parentId: plan.destParent,
				transferred: 0,
				size: plan.file.data.byteLength,
				done: false,
				entryKind: 'file'
			});
		}
		let settled = 0;
		await driver.writeFilesAcross(
			planned.map((plan) => ({
				parentId: plan.destParent,
				file: new File([plan.file.data as BlobPart], plan.name)
			})),
			{
				signal,
				pack,
				onProgress: (written) => {
					for (const entry of written) {
						const plan = planned[settled++];
						onFile?.({
							name: entry.name,
							parentId: entry.parentId ?? null,
							transferred: plan?.file.data.byteLength ?? entry.size ?? 0,
							size: plan?.file.data.byteLength ?? entry.size ?? 0,
							done: true,
							entryKind: 'file'
						});
					}
				}
			}
		);
		return;
	}

	if (typeof driver.writeFiles === 'function') {
		const groups = new Map<string | null, Planned[]>();
		for (const plan of planned) {
			const group = groups.get(plan.destParent);
			if (group) group.push(plan);
			else groups.set(plan.destParent, [plan]);
		}
		for (const [destParent, group] of groups) {
			throwIfAborted(signal);
			// Hand the WHOLE group over and let the driver chunk it. Slicing into
			// 24s here capped every internal batch at 24 and cost ~60% more OPFS
			// round trips (2015ms vs 1237ms per 3000 members); chunking belongs
			// where the cost is. Per-file UI ticks still fire via onProgress.
			for (const plan of group) {
				onFile?.({
					name: plan.name,
					parentId: destParent,
					transferred: 0,
					size: plan.file.data.byteLength,
					done: false,
					entryKind: 'file'
				});
			}
			// The File constructor snapshots bytes once per member, same as the
			// per-file path — no extra defensive copies.
			let settled = 0;
			await driver.writeFiles(
				destParent,
				group.map((plan) => new File([plan.file.data as BlobPart], plan.name)),
				{
					signal,
					pack,
					onProgress: (written) => {
						// Written entries arrive in input order, so they line up
						// with `group` and each chunk can be marked done as it lands.
						for (let i = 0; i < written.length && settled < group.length; i++) {
							const plan = group[settled++]!;
							const size = plan.file.data.byteLength;
							onFile?.({
								name: plan.name,
								parentId: destParent,
								transferred: size,
								size,
								done: true,
								entryKind: 'file'
							});
							if (plan.dirs.length) bumpFolderAggs(plan.dirs, size);
						}
					}
				}
			);
			throwIfAborted(signal);
			// Drivers without onProgress support settle everything at the end.
			while (settled < group.length) {
				const plan = group[settled++]!;
				const size = plan.file.data.byteLength;
				onFile?.({
					name: plan.name,
					parentId: destParent,
					transferred: size,
					size,
					done: true,
					entryKind: 'file'
				});
				if (plan.dirs.length) bumpFolderAggs(plan.dirs, size);
			}
			await yieldPaint();
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
		throwIfAborted(signal);
		// Whole group in one call — vfs.writeFiles owns chunking (see the driver
		// path above for why slicing at 24 here was costing round trips).
		for (const plan of group) {
			onFile?.({
				name: plan.name,
				parentId: destParent,
				transferred: 0,
				size: plan.file.data.byteLength,
				done: false
			});
		}
		let settled = 0;
		const settle = (upTo: number) => {
			while (settled < upTo) {
				const plan = group[settled++]!;
				onFile?.({
					name: plan.name,
					parentId: destParent,
					transferred: plan.file.data.byteLength,
					size: plan.file.data.byteLength,
					done: true
				});
			}
		};
		await vfs.writeFiles(
			group.map((plan) => ({
				parentId: destParent,
				name: plan.name,
				body: Uint8Array.from(plan.file.data)
			})),
			{
				signal,
				onProgress: (written) => settle(Math.min(settled + written.length, group.length))
			}
		);
		settle(group.length);
		await yieldPaint();
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
	/**
	 * Streaming sink. When set, each member is handed over as soon as it is
	 * expanded and NOT accumulated — the returned array is empty and the sink
	 * owns the bytes. Awaited, so a slow writer throttles the expander, which
	 * is what keeps peak memory to a window instead of the whole archive.
	 */
	onEntry?: (entry: PackedPath) => void | Promise<void>;
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
		const out: PackedPath[] = [];
		for (const e of mapped) {
			throwIfAborted(opts?.signal);
			// openVault decrypts the whole payload at once, so this does not bound
			// OUR memory — but streaming still lets the writer land members as
			// they come instead of after the last one.
			if (opts?.onEntry) await opts.onEntry(e);
			else out.push(e);
			onMember?.({
				path: e.path,
				transferred: e.data.byteLength,
				size: e.data.byteLength,
				done: true
			});
			await yieldPaint();
		}
		return out;
	}
	const fmt = detectFormat(bytes, name);
	if (!fmt) throw new Error(`Not a recognized archive: ${name}`);
	const role = describeCompressRole(preferred, fmt.codec, 'expand');
	opts?.onEngine?.(role);
	// A .tar.gz expands in two stages, and only the SECOND yields real members
	// — so the sink is attached to the final stage, never the intermediate tar.
	const twoStage = looksTarGzName(name);
	const files = await expandBytes(role.used as CompressEngineId, bytes, fmt.codec, name, {
		skipSystemFiles,
		signal: opts?.signal,
		onEntry:
			opts?.onEntry && !twoStage
				? async (entry) => {
						throwIfAborted(opts.signal);
						await opts.onEntry!({ path: entry.name, data: entry.data });
					}
				: undefined,
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
					onEntry: opts?.onEntry
						? async (entry) => {
								throwIfAborted(opts.signal);
								if (!keep(entry.name)) return;
								await opts.onEntry!({ path: entry.name, data: entry.data });
							}
						: undefined,
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
	/**
	 * Store extracted members in shared packs. Projects only — the general
	 * filesystem leaves this off (see VfsService.writeFiles for why).
	 */
	pack?: boolean;
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
	/**
	 * Progress only ever moves forward.
	 *
	 * Several of these jobs run against an ESTIMATED total that is revised
	 * upward mid-flight (a stream cannot know an archive's expanded size in
	 * advance). Emitting the raw ratio meant every upward revision of the
	 * denominator dropped the bar — the classic sawtooth of a bar that climbs
	 * to nearly full, snaps back, and climbs again, once per revision. The
	 * estimate still has to grow to stay honest; what must not happen is
	 * showing the user progress going backwards.
	 */
	const emitJobPct = (pct: number, done = false) => {
		const raw = done ? 100 : Math.min(99, Math.max(0, Math.round(pct)));
		const n = done ? 100 : Math.max(lastJobPct, raw);
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

	// Pipeline whenever the destination is a real folder. `popup` and `memory`
	// build a fresh inner filesystem and genuinely need the whole set first.
	//
	// wrapInSubfolder does NOT need it: the container name only depends on the
	// archive's own name, so it can be created up front and streamed into.
	// (It used to gate the pipeline off — and since the dialog defaults it ON,
	// the default extract never pipelined at all.)
	const writesToFolder = dest === 'same' || dest === 'folder';

	if (writesToFolder) {
		setNote(`${expandVerb}…`);
		// A stream cannot know the expanded total up front, but the archive's own
		// compressed size IS known — and expanded output is reliably larger. So
		// progress rides bytes-out against a running estimate that starts at the
		// compressed size and grows if the archive turns out to expand further.
		// This moves from 0% on the first member instead of after the last one.
		const compressedBytes = Math.max(
			sources.reduce((n, e) => n + (e.size ?? 0), 0),
			1
		);
		let bytesOut = 0;
		// Start above the compressed size rather than at it. Anything that
		// compressed at all expands past 1x, so seeding the estimate at 1x
		// guaranteed an overshoot on nearly every archive; 2x is a closer first
		// guess for typical mixed content, and under-guessing now only makes the
		// bar fill more slowly rather than jump.
		let estimatedTotal = compressedBytes * 2;
		let streamParent = destParentId;
		if (spec.wrapInSubfolder && driver.mkdir) {
			throwIfAborted(signal);
			const stem = extractContainerName(sources[0]?.name ?? title);
			const folderName = await uniqueChildFolderName(driver, destParentId, stem);
			streamParent = (await driver.mkdir(destParentId, folderName)).id;
		}
		const writer = createStreamingWriter({
			driver,
			parentId: streamParent,
			pack: spec.pack,
			onFile: (ev) => {
				onProgress?.(ev);
			},
			signal
		});
		let streamed = 0;
		for (const entry of sources) {
			throwIfAborted(signal);
			const bytes = await readEntryBytes(driver, entry);
			await expandPackedBytes(bytes, entry.name, spec.password, undefined, {
				skipSystemFiles: spec.skipSystemFiles,
				signal,
				compressEngineId: spec.compressEngineId,
				onVaultProgress: (stage, total) => {
					setNote(`Unsealing vault — stage ${stage} of ${total}…`);
				},
				onEngine: (role) => {
					remember(role, expandVerb);
					expandEngineLabel = role.usedLabel;
				},
				onEntry: async (member) => {
					await writer.push(member);
					streamed += 1;
					bytesOut += member.data.byteLength;
					// Never let the estimate be overtaken: if output exceeds it, the
					// archive compressed better than assumed, so grow the denominator
					// rather than report a fraction over 1.
					if (bytesOut > estimatedTotal) estimatedTotal = Math.ceil(bytesOut * 1.5);
					emitJobPct((bytesOut / estimatedTotal) * 100);
					setNote(
						expandEngineLabel
							? `${expandVerb} with ${expandEngineLabel} — ${streamed} file${
									streamed === 1 ? '' : 's'
								}…`
							: `${streamed} file${streamed === 1 ? '' : 's'}…`
					);
				}
			});
		}
		const written = await writer.finish();
		if (!written) throw new Error('Nothing to extract');
		emitJobPct(100, true);
		return { title, engines };
	}

	// Destinations that are not a VFS folder (the in-memory dest, download)
	// take this path, and it used to emit no fraction at all — only labels. So
	// inflating, which is most of the wait, showed a bar frozen at 0% and the
	// job appeared to do nothing until the writes began. Ride the same
	// bytes-out estimate the streaming path uses so the inflate phase is
	// visible here too.
	const inMemoryCompressedBytes = Math.max(
		sources.reduce((n, e) => n + (e.size ?? 0), 0),
		1
	);
	let inMemoryBytesOut = 0;
	let inMemoryEstimate = inMemoryCompressedBytes * 2;

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
					if (ev.done) {
						membersDone++;
						inMemoryBytesOut += ev.transferred;
						if (inMemoryBytesOut > inMemoryEstimate) {
							inMemoryEstimate = Math.ceil(inMemoryBytesOut * 1.5);
						}
						// Cap the inflate phase below the top of the bar: the writes
						// that follow are real work too, and must have somewhere to
						// go. emitJobPct is monotonic, so this never snaps back.
						emitJobPct((inMemoryBytesOut / inMemoryEstimate) * 90);
					}
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
	// Folder destinations return from the streaming branch above; only the
	// inner-filesystem dests (memory) reach here.
	setNote('Writing extracted files…');
	await writeOut(inner);
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
