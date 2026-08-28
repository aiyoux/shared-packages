/**
 * Dual-pane copy-across bridge (does not flip local caps).
 *
 * Lives in the shared package so both the hub `/tools/files` page and the
 * Connections `FileTransferPanel` (via {@link DualPaneExplorer}) single-source it.
 * @see docs/design/dnd-inmem-copy.md
 */
import { generateId } from '../id.js';
import { ferryWebrtcCopy, isWebrtcCopyPeer } from '../monitor/webrtcCopy.js';
import { upsertProgress, type CopyHop, type CopyIce, type CopyIcePath } from '../transferRegistry.js';
import {
	EXPLORER_DOWNLOAD_MAX_BYTES,
	isRemoteClass,
	readExplorerBlob,
	type ExplorerDriver,
	type ExplorerEntry
} from './explorerDriver.js';

export type CopyAcrossErrorCode =
	| 'COPY_ACROSS_REMOTE_REMOTE'
	| 'COPY_ACROSS_DEST_NO_FOLDERS'
	| 'COPY_ACROSS_NO_SELECTION'
	| 'COPY_ACROSS_NO_SOURCE'
	| 'COPY_ACROSS_NO_DEST'
	| 'COPY_ACROSS_DEST_READONLY'
	| 'COPY_ACROSS_TRUNCATED'
	| 'EXPLORER_TOO_LARGE'
	| string;

export class CopyAcrossError extends Error {
	readonly code: CopyAcrossErrorCode;
	constructor(code: CopyAcrossErrorCode, message?: string) {
		super(message ?? code);
		this.code = code;
		this.name = 'CopyAcrossError';
	}
}

/** Native DnD type FileExplorer writes; DualPaneExplorer reads it on pane drop. */
export const FE_EXPLORER_IDS_MIME = 'application/x-fe-explorer-ids';
export const FE_CM_EXPLORER_IDS_MIME = 'application/x-cm-explorer-ids';

/** True while the OS/browser is dragging real files (not an explorer row). */
export function dataTransferHasOsFiles(dt: DataTransfer | null | undefined): boolean {
	if (!dt) return false;
	if (dt.files && dt.files.length > 0) return true;
	const types = Array.from(dt.types ?? []);
	return types.includes('Files');
}

export function dataTransferHasExplorerIds(dt: DataTransfer | null | undefined): boolean {
	if (!dt) return false;
	const types = Array.from(dt.types ?? []);
	return (
		types.includes(FE_EXPLORER_IDS_MIME) ||
		types.includes(FE_CM_EXPLORER_IDS_MIME) ||
		types.includes('application/x-fe-explorer-ids')
	);
}

export function filesFromDataTransfer(dt: DataTransfer | null | undefined): File[] {
	if (!dt?.files?.length) return [];
	return Array.from(dt.files);
}

export type ExplorerDragPayload = { driverId?: string; ids: string[]; connectionId?: string };

function idsFromCommaList(raw: string): string[] {
	return raw
		.split(',')
		.map((id) => id.trim())
		.filter(Boolean);
}

/** JSON `{driverId,ids}` (current) or a comma-separated id list (legacy). */
export function parseExplorerDragPayload(raw: string): ExplorerDragPayload {
	const trimmed = raw.trim();
	if (!trimmed) return { ids: [] };
	if (trimmed.startsWith('{')) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				const o = parsed as { driverId?: unknown; ids?: unknown; connectionId?: unknown };
				if (Array.isArray(o.ids)) {
					const ids = o.ids.filter((id): id is string => typeof id === 'string' && id !== '');
					const driverId = typeof o.driverId === 'string' && o.driverId ? o.driverId : undefined;
					const connectionId =
						typeof o.connectionId === 'string' && o.connectionId ? o.connectionId : undefined;
					return {
						ids,
						...(driverId ? { driverId } : {}),
						...(connectionId ? { connectionId } : {})
					};
				}
			}
		} catch {
			/* fall through to comma list */
		}
	}
	return { ids: idsFromCommaList(trimmed) };
}

export function parseExplorerDragIds(raw: string): string[] {
	return parseExplorerDragPayload(raw).ids;
}

export function explorerDragFromDataTransfer(
	dt: DataTransfer | null | undefined
): ExplorerDragPayload {
	if (!dt) return { ids: [] };
	let raw = '';
	try {
		raw = dt.getData(FE_EXPLORER_IDS_MIME) || '';
	} catch {
		raw = '';
	}
	if (raw) return parseExplorerDragPayload(raw);
	try {
		raw = dt.getData('text/plain') || '';
	} catch {
		raw = '';
	}
	return parseExplorerDragPayload(raw);
}

export function idsFromExplorerDataTransfer(dt: DataTransfer | null | undefined): string[] {
	return explorerDragFromDataTransfer(dt).ids;
}

/** Drop on a folder row copies into that folder; otherwise dest's open folder. */
/**
 * Row ids for a dragstart that bubbled from a FileExplorer row. Chrome often
 * leaves getData() empty until drop, so DualPane / CM send-zone use this.
 */
export function idsFromExplorerDragTarget(target: EventTarget | null): string[] {
	const el = target as {
		closest?: (sel: string) => {
			getAttribute(name: string): string | null;
			closest(sel: string): {
				querySelectorAll(sel: string): Iterable<{ getAttribute(name: string): string | null }>;
			} | null;
		} | null;
	} | null;
	if (!el || typeof el.closest !== 'function') return [];
	const row = el.closest('[data-fe-row-id]');
	if (!row) return [];
	const draggedId = row.getAttribute('data-fe-row-id');
	if (!draggedId) return [];
	const list = row.closest('[data-testid="fe-list"]');
	if (list) {
		const selected: string[] = [];
		for (const n of list.querySelectorAll('.fe-row.selected[data-fe-row-id]')) {
			const id = n.getAttribute('data-fe-row-id');
			if (id) selected.push(id);
		}
		if (selected.length > 0 && selected.includes(draggedId)) return selected;
	}
	return [draggedId];
}

export function destParentFromDropEvent(
	e: { target: EventTarget | null },
	fallback: string | null
): string | null {
	const el = e.target as { closest?: (sel: string) => { getAttribute(name: string): string | null } | null } | null;
	if (!el || typeof el.closest !== 'function') return fallback;
	const row = el.closest('[data-fe-row-id]');
	if (row?.getAttribute('data-fe-kind') === 'folder') {
		return row.getAttribute('data-fe-row-id');
	}
	return fallback;
}

export type CopyAcrossArgs = {
	sourceDriver: ExplorerDriver;
	destDriver: ExplorerDriver;
	/** Selected entry ids on source (files and/or folders). */
	selectedIds: string[];
	/** Entries currently listed on source (for kind/name lookup). */
	sourceEntries: ExplorerEntry[];
	/** Destination open folder id (null = root). */
	destParentId: string | null;
	/** ICE-fail fallback: confirm dual-phase through this device. */
	confirmDualPhase?: () => Promise<boolean>;
	signal?: AbortSignal;
};

function entryById(entries: ExplorerEntry[], id: string): ExplorerEntry | undefined {
	return entries.find((e) => e.id === id);
}

function nonEmptyKey(d: ExplorerDriver): string | null {
	const k = d.endpointKey;
	return typeof k === 'string' && k !== '' ? k : null;
}

export type CopyAcrossPathKind =
	| 'server'
	| 'delegated'
	| 'webrtc'
	| 'dual-phase'
	| 'direct'
	| 'blocked'
	| 'idle';

export type CopyAcrossClass = { kind: CopyAcrossPathKind };

/**
 * Single routing decision for dual-pane copy-across.
 * DualPane must not reimplement this — call classify, then execute.
 */
export function classify(source: ExplorerDriver, dest: ExplorerDriver): CopyAcrossClass {
	const blocked = destCannotWrite(dest);
	if (blocked) return { kind: 'blocked' };

	const srcKey = nonEmptyKey(source);
	const dstKey = nonEmptyKey(dest);
	const sameCid = Boolean(
		source.connectionId && dest.connectionId && source.connectionId === dest.connectionId
	);

	// Two disk drivers never server-copy even if dest.copy exists.
	const bothDisk = source.id === 'disk' && dest.id === 'disk';
	if (!bothDisk) {
		// a. rclone (and others) only via same connectionId + dest.copy
		if (sameCid && dest.copy) return { kind: 'server' };
		// b. DualPane local×local: same object + dest.copy
		if (source === dest && dest.copy) return { kind: 'server' };
		// c. same monitor host (non-empty endpointKey)
		if (source.id === 'monitor' && dest.id === 'monitor' && srcKey && srcKey === dstKey) {
			return { kind: 'server' };
		}
		// d. same B2 bucket
		if (source.id === 'b2' && dest.id === 'b2' && srcKey && srcKey === dstKey && dest.copy) {
			return { kind: 'server' };
		}
	}

	// Distinct B2 buckets are NOT delegated.
	if (source.id === 'b2' && dest.id === 'monitor') return { kind: 'delegated' };
	if (source.id === 'monitor' && dest.id === 'b2') return { kind: 'delegated' };

	if (source.id === 'monitor' && dest.id === 'monitor' && srcKey && dstKey && srcKey !== dstKey) {
		return { kind: 'webrtc' };
	}

	if (isRemoteClass(source.id) && isRemoteClass(dest.id)) return { kind: 'dual-phase' };
	return { kind: 'direct' };
}

export function canServerCopy(source: ExplorerDriver, dest: ExplorerDriver): boolean {
	return classify(source, dest).kind === 'server';
}

export function isDualPhaseCopy(source: ExplorerDriver, dest: ExplorerDriver): boolean {
	return classify(source, dest).kind === 'dual-phase';
}

export type CopyAcrossPath = {
	kind: CopyAcrossPathKind;
	summary: string;
	detail: string;
};

function backendName(id: string): string {
	if (id === 'b2') return 'Backblaze B2';
	if (id === 'monitor') return 'monitor';
	if (id === 'rclone') return 'rclone';
	if (id === 'peer-fs') return 'the other device';
	if (id === 'disk') return 'This computer';
	if (id === 'memory') return 'In memory';
	if (id === 'local') return 'Browser files';
	return id;
}

/**
 * Human description of the copy route for the current source → dest pair.
 * Used by the connection (i) tooltip so the live pane config is visible.
 */
export function describeCopyAcrossPath(
	source: ExplorerDriver,
	dest: ExplorerDriver,
	labels: { source: string; dest: string }
): CopyAcrossPath {
	const { kind } = classify(source, dest);
	if (kind === 'blocked') {
		const blocked = destCannotWrite(dest);
		return {
			kind: 'blocked',
			summary: `Cannot copy into ${labels.dest}`,
			detail: blocked?.message ?? 'Destination cannot accept file writes'
		};
	}
	if (kind === 'server') {
		const where = backendName(source.id);
		if (source.id === 'monitor') {
			const rootsDiffer = source.connectionId !== dest.connectionId;
			return {
				kind: 'server',
				summary: 'Server copy on monitor',
				detail: rootsDiffer
					? 'Both panes share the same monitor host with different roots. The daemon copies by absolute path — nothing streams through this browser.'
					: 'Both panes share the same monitor host. The daemon copies on that machine — nothing streams through this browser.'
			};
		}
		const detail =
			source.id === 'b2'
				? 'Both panes are the same B2 bucket. B2 copies on the server — nothing downloads through this browser.'
				: source.id === 'rclone'
					? 'Both panes are the same rclone remote. rclone copies on the remote — nothing downloads through this browser.'
					: source.id === 'local'
						? "Both panes are this browser's files. Copy is a local duplicate in Dexie/OPFS."
						: source.id === 'memory'
							? "Both panes are this tab's in-memory list. Copy stays in this tab."
							: `Both panes are the same ${where} connection. The API copies in place — nothing downloads through this browser.`;
		return {
			kind: 'server',
			summary: `Server copy on ${where}`,
			detail
		};
	}
	if (kind === 'delegated') {
		if (source.id === 'b2' && dest.id === 'monitor') {
			return {
				kind: 'delegated',
				summary: `Delegated: ${labels.source} → ${labels.dest}`,
				detail:
					'This tab mints a short-lived B2 download URL; the monitor daemon GETs it. Application keys stay in this tab. No confirm.'
			};
		}
		return {
			kind: 'delegated',
			summary: `Delegated: ${labels.source} → ${labels.dest}`,
			detail:
				'This tab mints a short-lived B2 upload URL; the monitor daemon PUTs the file. Application keys stay in this tab. No confirm.'
		};
	}
	if (kind === 'webrtc') {
		return {
			kind: 'webrtc',
			summary: 'WebRTC between monitors',
			detail:
				'This tab only exchanges offer/answer. Each daemon copies over WebRTC. If ICE fails, a dual-phase confirm may appear and the copy can continue through this device.'
		};
	}
	if (kind === 'dual-phase') {
		const src = backendName(source.id);
		const dst = backendName(dest.id);
		return {
			kind: 'dual-phase',
			summary: `Dual-phase: ${labels.source} → this device → ${labels.dest}`,
			detail: `${src} and ${dst} cannot talk directly. This browser downloads from ${labels.source}, then uploads to ${labels.dest}. Transfer can start as pieces arrive. A confirm popup appears before it starts.`
		};
	}
	return {
		kind: 'direct',
		summary: `Copy through this device`,
		detail: `Read from ${labels.source} (${backendName(source.id)}) and write to ${labels.dest} (${backendName(dest.id)}) with one progress bar.`
	};
}

/**
 * Copy selected items from source driver into dest open folder.
 */
export async function copyAcross(args: CopyAcrossArgs): Promise<number> {
	const {
		sourceDriver,
		destDriver,
		selectedIds,
		sourceEntries,
		destParentId,
		confirmDualPhase,
		signal
	} = args;
	if (!selectedIds.length) {
		throw new CopyAcrossError('COPY_ACROSS_NO_SELECTION', 'Select file(s) to copy');
	}

	const selected = selectedIds
		.map((id) => entryById(sourceEntries, id))
		.filter((e): e is ExplorerEntry => !!e);

	const hasFolder = selected.some((e) => e.kind === 'folder');
	// memory is a flat list (no folders) — block even though it is local-class.
	if (hasFolder && !destDriver.capabilities.supportsMkdir) {
		throw new CopyAcrossError(
			'COPY_ACROSS_DEST_NO_FOLDERS',
			'Destination cannot hold folders'
		);
	}

	let count = 0;
	for (const entry of selected) {
		if (entry.kind === 'folder') {
			count += await copyFolderTree(
				sourceDriver,
				destDriver,
				entry,
				destParentId,
				confirmDualPhase,
				signal
			);
		} else {
			await copyFile(sourceDriver, destDriver, entry, destParentId, confirmDualPhase, signal);
			count += 1;
		}
	}
	return count;
}

type CopyProgressPatch = {
	transferred: number;
	size?: number;
	done?: boolean;
	status?: 'active' | 'done' | 'failed' | 'cancelled';
	error?: string;
	hop?: CopyHop;
	ice?: CopyIce;
	icePath?: CopyIcePath;
	hopNote?: string;
};

function reportCopy(id: string, entry: ExplorerEntry, patch: CopyProgressPatch): void {
	const size = patch.size ?? entry.size ?? patch.transferred;
	upsertProgress({
		id,
		name: entry.name,
		size,
		transferred: patch.transferred,
		direction: 'copying',
		done: patch.done === true,
		status: patch.status ?? (patch.done ? 'done' : 'active'),
		error: patch.error,
		hop: patch.hop,
		ice: patch.ice,
		icePath: patch.icePath,
		hopNote: patch.hopNote
	});
}

function webrtcHopNote(ice?: CopyIce, icePath?: CopyIcePath): string {
	if (ice === 'failed') return 'WebRTC failed — through this device';
	if (icePath === 'host') return 'WebRTC (host)';
	if (icePath === 'stun') return 'WebRTC (STUN)';
	return 'WebRTC (connecting)';
}

function delegatedNote(source: ExplorerDriver, dest: ExplorerDriver): string {
	if (source.id === 'b2' && dest.id === 'monitor') return 'Monitor ← B2';
	if (source.id === 'monitor' && dest.id === 'b2') return 'Monitor → B2';
	return 'Delegated';
}

function destCannotWrite(dest: ExplorerDriver): CopyAcrossError | null {
	const noWrite = !dest.writeFile && !dest.upload;
	if (dest.id === 'peer-fs' && noWrite) {
		return new CopyAcrossError('COPY_ACROSS_DEST_READONLY', 'That shared location is read-only');
	}
	if (noWrite && !dest.copy) {
		return new CopyAcrossError('COPY_ACROSS_NO_DEST', 'Destination cannot accept file writes');
	}
	return null;
}

async function copyFile(
	source: ExplorerDriver,
	dest: ExplorerDriver,
	entry: ExplorerEntry,
	destParentId: string | null,
	confirmDualPhase?: () => Promise<boolean>,
	signal?: AbortSignal
): Promise<void> {
	if (signal?.aborted) {
		const err = new Error('Copy cancelled');
		err.name = 'AbortError';
		throw err;
	}
	const kind = classify(source, dest).kind;
	const skipCap = kind === 'server' || kind === 'delegated' || kind === 'webrtc';
	if (!skipCap && entry.size != null && entry.size > EXPLORER_DOWNLOAD_MAX_BYTES) {
		throw new CopyAcrossError('EXPLORER_TOO_LARGE', 'File exceeds download size cap');
	}
	const opId = generateId('copy');
	const known = entry.size ?? 0;
	const dual = kind === 'dual-phase';
	const splitPush = kind === 'delegated' && source.id === 'monitor' && dest.id === 'b2';
	const dualLike = dual || splitPush;
	const hop: CopyHop | undefined =
		kind === 'idle' || kind === 'blocked' ? undefined : kind;
	const remoteId = `${opId}:remote`;
	const wireId = `${opId}:wire`;
	const hopNote =
		kind === 'delegated'
			? delegatedNote(source, dest)
			: kind === 'direct' || kind === 'dual-phase'
				? 'Through this device'
				: kind === 'server'
					? 'Server copy'
					: undefined;
	const reportLeg = (id: string, name: string, patch: CopyProgressPatch) => {
		upsertProgress({
			id,
			name,
			size: patch.size ?? known,
			transferred: patch.transferred,
			direction: 'copying',
			done: patch.done === true,
			status: patch.status ?? (patch.done ? 'done' : 'active'),
			error: patch.error,
			hop: patch.hop ?? hop,
			ice: patch.ice,
			icePath: patch.icePath,
			hopNote: patch.hopNote ?? hopNote
		});
	};
	const failAll = (err: unknown) => {
		const aborted = err instanceof Error && err.name === 'AbortError';
		const msg = err instanceof Error ? err.message : String(err);
		const status = aborted ? ('cancelled' as const) : ('failed' as const);
		const note = aborted ? 'Cancelled' : hopNote;
		if (dualLike) {
			reportLeg(remoteId, entry.name, {
				transferred: 0,
				size: known,
				done: true,
				status,
				error: aborted ? undefined : msg,
				hop,
				hopNote: note
			});
			reportLeg(wireId, entry.name, {
				transferred: 0,
				size: known,
				done: true,
				status,
				error: aborted ? undefined : msg,
				hop,
				hopNote: note
			});
		} else {
			reportCopy(opId, entry, {
				transferred: 0,
				size: known,
				done: true,
				status,
				error: aborted ? undefined : msg,
				hop,
				hopNote: note
			});
		}
	};

	if (kind === 'blocked') {
		const blocked =
			destCannotWrite(dest) ??
			new CopyAcrossError('COPY_ACROSS_NO_DEST', 'Destination cannot accept file writes');
		failAll(blocked);
		throw blocked;
	}

	if (kind === 'server') {
		reportCopy(opId, entry, { transferred: 0, size: known, status: 'active', hop: 'server', hopNote });
		try {
			const sameMonitorHost =
				source.id === 'monitor' &&
				dest.id === 'monitor' &&
				nonEmptyKey(source) &&
				nonEmptyKey(source) === nonEmptyKey(dest);
			const cidDiffer = source.connectionId !== dest.connectionId;
			if (sameMonitorHost && cidDiffer) {
				if (!source.absolutePath || !dest.copyFromAbsolute) {
					throw new CopyAcrossError(
						'COPY_ACROSS_NO_DEST',
						'Monitor cannot copy across roots (missing absolutePath/copyFromAbsolute)'
					);
				}
				await dest.copyFromAbsolute(source.absolutePath(entry.id), destParentId, entry.name, {
					onProgress: (transferred, total) => {
						reportCopy(opId, entry, {
							transferred,
							size: total ?? known ?? transferred,
							status: 'active',
							hop: 'server',
							hopNote
						});
					}
				});
			} else if (dest.copy) {
				await dest.copy(entry.id, destParentId, {
					onProgress: (transferred, total) => {
						reportCopy(opId, entry, {
							transferred,
							size: total ?? known ?? transferred,
							status: 'active',
							hop: 'server',
							hopNote
						});
					}
				});
			} else {
				throw new CopyAcrossError('COPY_ACROSS_NO_DEST', 'Destination cannot server-copy');
			}
			reportCopy(opId, entry, {
				transferred: known || 1,
				size: known || 1,
				done: true,
				status: 'done',
				hop: 'server',
				hopNote
			});
			return;
		} catch (e) {
			failAll(e);
			throw e;
		}
	}

	if (kind === 'delegated') {
		reportCopy(opId, entry, {
			transferred: 0,
			size: known,
			status: 'active',
			hop: 'delegated',
			hopNote
		});
		try {
			if (source.id === 'b2' && dest.id === 'monitor') {
				if (!source.mintDownloadUrl || !dest.pullFromUrl) {
					throw new CopyAcrossError(
						'COPY_ACROSS_NO_DEST',
						'Delegated B2 → monitor requires mintDownloadUrl and pullFromUrl'
					);
				}
				const minted = await source.mintDownloadUrl(entry.id);
				await dest.pullFromUrl(minted.url, destParentId, entry.name, {
					onProgress: (transferred, total) => {
						reportCopy(opId, entry, {
							transferred,
							size: total ?? known ?? transferred,
							status: 'active',
							hop: 'delegated',
							hopNote
						});
					}
				});
			} else if (source.id === 'monitor' && dest.id === 'b2') {
				if (!dest.mintUploadUrl || !source.pushToUpload) {
					throw new CopyAcrossError(
						'COPY_ACROSS_NO_SOURCE',
						'Delegated monitor → B2 requires mintUploadUrl and pushToUpload'
					);
				}
				const upload = await dest.mintUploadUrl(destParentId, entry.name);
				reportLeg(remoteId, entry.name, {
					transferred: 0,
					size: known,
					status: 'active',
					hop: 'delegated',
					hopNote
				});
				reportLeg(wireId, entry.name, {
					transferred: 0,
					size: known,
					status: 'active',
					hop: 'delegated',
					hopNote
				});
				let hashDone = false;
				await source.pushToUpload(entry.id, upload, {
					onEvent: (ev) => {
						const moved = ev.transferred ?? 0;
						const size = ev.size ?? known ?? moved;
						const phase = ev.phase;
						const isHash = phase === 'hash' || (!phase && !hashDone && !ev.done);
						if (isHash) {
							reportLeg(remoteId, entry.name, {
								transferred: moved,
								size,
								status: 'active',
								hop: 'delegated',
								hopNote
							});
							if (size > 0 && moved >= size) hashDone = true;
							return;
						}
						hashDone = true;
						reportLeg(remoteId, entry.name, {
							transferred: size,
							size,
							done: true,
							status: 'done',
							hop: 'delegated',
							hopNote
						});
						reportLeg(wireId, entry.name, {
							transferred: moved,
							size,
							done: ev.done === true,
							status: ev.done ? 'done' : 'active',
							hop: 'delegated',
							hopNote
						});
					}
				});
			} else {
				throw new CopyAcrossError('COPY_ACROSS_NO_DEST', 'Unsupported delegated pair');
			}
			if (splitPush) {
				reportLeg(remoteId, entry.name, {
					transferred: known || 1,
					size: known || 1,
					done: true,
					status: 'done',
					hop: 'delegated',
					hopNote
				});
				reportLeg(wireId, entry.name, {
					transferred: known || 1,
					size: known || 1,
					done: true,
					status: 'done',
					hop: 'delegated',
					hopNote
				});
			} else {
				reportCopy(opId, entry, {
					transferred: known || 1,
					size: known || 1,
					done: true,
					status: 'done',
					hop: 'delegated',
					hopNote
				});
			}
			return;
		} catch (e) {
			failAll(e);
			throw e;
		}
	}

	if (kind === 'webrtc') {
		reportCopy(opId, entry, {
			transferred: 0,
			size: known,
			status: 'active',
			hop: 'webrtc',
			ice: 'checking',
			hopNote: webrtcHopNote('checking')
		});
		try {
			if (!isWebrtcCopyPeer(source) || !isWebrtcCopyPeer(dest)) {
				throw new CopyAcrossError(
					'COPY_ACROSS_NO_DEST',
					'Both monitors must support WebRTC ferry'
				);
			}
			await ferryWebrtcCopy({
				source,
				dest,
				entry,
				destParentId,
				confirmDualPhase,
				onProgress: (ev) => {
					const ice = ev.ice;
					const icePath = ev.icePath;
					reportCopy(opId, entry, {
						transferred: ev.transferred,
						size: ev.size ?? known,
						status: ev.done ? 'done' : 'active',
						done: ev.done === true,
						error: ev.error,
						hop: ice === 'failed' ? 'dual-phase' : 'webrtc',
						ice,
						icePath,
						hopNote: webrtcHopNote(ice, icePath)
					});
				}
			});
			reportCopy(opId, entry, {
				transferred: known || 1,
				size: known || 1,
				done: true,
				status: 'done'
			});
			return;
		} catch (e) {
			failAll(e);
			throw e;
		}
	}

	if (dual) {
		reportLeg(remoteId, `Download · ${source.id}`, {
			transferred: 0,
			size: known,
			status: 'active',
			hop: 'dual-phase',
			hopNote
		});
		reportLeg(wireId, entry.name, {
			transferred: 0,
			size: known,
			status: 'active',
			hop: 'dual-phase',
			hopNote
		});
	} else {
		reportCopy(opId, entry, {
			transferred: 0,
			size: known,
			status: 'active',
			hop: 'direct',
			hopNote
		});
	}

	try {
		let blob: Blob;
		if (source.download) {
			blob = await source.download(entry.id, {
				signal,
				onProgress: (transferred, total) => {
					const size = total ?? known ?? transferred;
					if (dual) {
						reportLeg(remoteId, `Download · ${source.id}`, {
							transferred,
							size,
							status: 'active',
							hop: 'dual-phase',
							hopNote
						});
					} else {
						reportCopy(opId, entry, {
							transferred,
							size,
							status: 'active',
							hop: 'direct',
							hopNote
						});
					}
				}
			});
		} else if (source.readBlob) {
			blob = await source.readBlob(entry.id);
		} else {
			throw new CopyAcrossError('COPY_ACROSS_NO_SOURCE', 'Source cannot read file bytes');
		}
		if (blob.size > EXPLORER_DOWNLOAD_MAX_BYTES) {
			throw new CopyAcrossError('EXPLORER_TOO_LARGE', 'File exceeds download size cap');
		}
		if (dual) {
			reportLeg(remoteId, `Download · ${source.id}`, {
				transferred: blob.size,
				size: blob.size,
				done: true,
				status: 'done',
				hop: 'dual-phase',
				hopNote
			});
		} else if (dest.upload) {
			// Local VFS reads finish instantly (often with no download ticks).
			// Do not paint 100% until dest.upload reports PUT progress.
			reportCopy(opId, entry, {
				transferred: 0,
				size: blob.size,
				status: 'active',
				hop: 'direct',
				hopNote
			});
		} else {
			reportCopy(opId, entry, {
				transferred: blob.size,
				size: blob.size,
				status: 'active',
				hop: 'direct',
				hopNote
			});
		}
		const file = new File([blob], entry.name, {
			type: entry.contentType || blob.type || 'application/octet-stream'
		});

		if (dest.writeFile) {
			await dest.writeFile(destParentId, file);
			if (dual) {
				reportLeg(wireId, entry.name, {
					transferred: blob.size,
					size: blob.size,
					done: true,
					status: 'done',
					hop: 'dual-phase',
					hopNote
				});
			}
		} else if (dest.upload) {
			await dest.upload(destParentId, file, {
				signal,
				onProgress: (pct) => {
					const transferred = Math.round(blob.size * Math.min(1, Math.max(0, pct)));
					if (dual) {
						reportLeg(wireId, entry.name, {
							transferred,
							size: blob.size,
							status: 'active',
							hop: 'dual-phase',
							hopNote
						});
					} else {
						reportCopy(opId, entry, {
							transferred,
							size: blob.size,
							status: 'active',
							hop: 'direct',
							hopNote
						});
					}
				}
			});
			if (dual) {
				reportLeg(wireId, entry.name, {
					transferred: blob.size,
					size: blob.size,
					done: true,
					status: 'done',
					hop: 'dual-phase',
					hopNote
				});
			}
		} else {
			throw new CopyAcrossError('COPY_ACROSS_NO_DEST', 'Destination cannot accept file writes');
		}
		if (!dual) {
			reportCopy(opId, entry, {
				transferred: blob.size,
				size: blob.size,
				done: true,
				status: 'done',
				hop: 'direct',
				hopNote
			});
		}
	} catch (e) {
		failAll(e);
		throw e;
	}
}

async function copyFolderTree(
	source: ExplorerDriver,
	dest: ExplorerDriver,
	folder: ExplorerEntry,
	destParentId: string | null,
	confirmDualPhase?: () => Promise<boolean>,
	signal?: AbortSignal
): Promise<number> {
	if (!dest.mkdir) {
		throw new CopyAcrossError('COPY_ACROSS_DEST_NO_FOLDERS', 'Destination cannot create folders');
	}
	const created = await dest.mkdir(destParentId, folder.name);
	let count = 1;
	const listed = await source.list({ parentId: folder.id });
	if (listed.truncated) {
		throw new CopyAcrossError(
			'COPY_ACROSS_TRUNCATED',
			'Folder has more than 2000 items; copy aborted so nothing is silently dropped'
		);
	}
	const { entries } = listed;
	const bulk = canBulkWriteDest(source, dest);
	// Files are windowed so a huge folder does not sit fully in memory before
	// anything lands; the window matches the store's own write chunk.
	const WINDOW = 512;
	let pending: Array<{ entry: ExplorerEntry; file: File }> = [];
	const flush = async () => {
		if (!pending.length) return;
		const batch = pending;
		pending = [];
		await dest.writeFiles!(
			created.id,
			batch.map((b) => b.file),
			{ signal }
		);
		for (const b of batch) {
			reportCopy(generateId('copy'), b.entry, {
				transferred: b.file.size,
				size: b.file.size,
				done: true,
				status: 'done',
				hop: 'direct'
			});
		}
	};

	for (const child of entries) {
		if (child.kind === 'folder') {
			await flush();
			count += await copyFolderTree(source, dest, child, created.id, confirmDualPhase, signal);
			continue;
		}
		if (bulk) {
			if (signal?.aborted) {
				const err = new Error('Copy cancelled');
				err.name = 'AbortError';
				throw err;
			}
			const blob = await readExplorerBlob(source, child.id);
			pending.push({
				entry: child,
				file: new File([blob], child.name, {
					type: child.contentType || blob.type || 'application/octet-stream'
				})
			});
			count += 1;
			if (pending.length >= WINDOW) await flush();
			continue;
		}
		await copyFile(source, dest, child, created.id, confirmDualPhase, signal);
		count += 1;
	}
	await flush();
	return count;
}

/**
 * True when a whole folder's files can be handed to the destination in one
 * bulk write instead of one call per file.
 *
 * Only the `direct` shape qualifies: the file is already a Blob in this tab
 * and the destination is a local store with a bulk write. Every other shape
 * (`server`, `delegated`, `webrtc`, `dual-phase`) carries per-file transfer
 * reporting — hops, ICE paths, integrity, resume — that a single bulk call
 * cannot express, and those are network-bound anyway, where per-file OPFS
 * overhead is not what costs.
 */
function canBulkWriteDest(source: ExplorerDriver, dest: ExplorerDriver): boolean {
	return classify(source, dest).kind === 'direct' && typeof dest.writeFiles === 'function';
}
