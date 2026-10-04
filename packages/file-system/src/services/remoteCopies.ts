/**
 * Working copies of remote files.
 *
 * Opening a monitor or B2 file opens a copy in this browser's files, in every
 * app, the same way. The editor reads and saves that copy like any local file,
 * so editing never waits on the network. Each Save of the copy (a new file
 * generation) is sent back to where the file lives, in the background:
 *
 *   Open  → copy in once (streamed; no in-tab size cap) → the app opens the copy
 *   Save  → the app writes the copy (as for any file) → this sends it back
 *   Again → if the remote has not changed and the copy is still here, no copy
 *
 * A send replaces the remote file only if it is still the version the copy was
 * made from (`writeBack({ expectUpdatedAt })`). When it moved on, the copy is
 * marked `conflict` and nothing is overwritten until the person chooses.
 *
 * One tab sends at a time: each send holds the copy's Web Lock, and a tab that
 * died mid-send releases it, so the next tab in the queue re-reads the record
 * and carries on. No timer decides anything here.
 */
import { generateId } from '../id.js';
import { getSharedVfs } from '../vfs.js';
import type { VfsNode } from '../types.js';
import { acquireMonitorDriver, releaseMonitorDriver } from '../monitor/monitorDriverCache.js';
import { getProfile } from '../monitor/credentials.js';
import { acquireB2Driver, releaseB2Driver } from '../b2/b2DriverCache.js';
import { getB2Connection } from '../b2/connections.js';
import { estimateTransferMs, linkBytesPerSecond } from '../linkSpeed.js';
import { fetchByteRange } from '../ui/rangedRead.js';
import {
	RemoteChangedError,
	type ExplorerDriver,
	type ExplorerEntry
} from '../ui/explorerDriver.js';
import { createLiveBus, type LiveBus } from '../live/bus.js';
import { serviceNames } from './names.js';
import { listWorkspaceSessions } from '../workspaceSessions.js';
import { startOp, type OpHandle, type Endpoint } from './ops.js';

/** Where a working copy came from. */
export type RemoteCopySource = {
	/** The saved connection (`monitor:<profileId>`, `b2:<rowId>`). */
	connectionId: string;
	driverId: string;
	/** The entry id in that connection's driver. */
	remoteId: string;
	/** The connection's name, for prompts and status ("Office PC"). */
	label: string;
	name: string;
};

export type RemoteCopyState = 'synced' | 'sending' | 'conflict' | 'failed';

export type RemoteCopy = {
	nodeId: string;
	source: RemoteCopySource;
	/** The remote version the copy last matched (made from, or last sent). */
	base: { updatedAt?: number; size?: number };
	/** The copy's file generation that matches `base`. */
	syncedGeneration: number;
	state: RemoteCopyState;
	error?: string;
	/** A failed send is retried by the next Save, not by every catalog change. */
	failedGeneration?: number;
	/** The running send's op, for its progress. Set only while `sending`. */
	opId?: string;
	/**
	 * `false`: a plain copy for a document opened live on its monitor. The
	 * monitor's room keeps the file, so this copy never sends anything back.
	 */
	sendBack?: false;
	/** Last opened, for freeing space: the least recently opened goes first. */
	openedAt?: number;
};

/** The parts of the VFS this service uses. */
export type RemoteCopyVfs = {
	get(id: string): Promise<VfsNode | undefined>;
	getMeta<T = unknown>(key: string): Promise<T | undefined>;
	setMeta(key: string, value: unknown): Promise<void>;
	deleteMeta(key: string): Promise<void>;
	readBlob(id: string): Promise<Blob>;
	subscribe(listener: () => void): () => void;
	childByName(parentId: string | null, name: string): Promise<VfsNode | undefined>;
	mkdir(parentId: string | null, name: string): Promise<VfsNode>;
	ensureUniqueName(parentId: string | null, name: string): Promise<string>;
	writeFileStream(
		input: { parentId: string | null; name: string; contentType?: string },
		stream: ReadableStream<Uint8Array>,
		opts?: { signal?: AbortSignal }
	): Promise<VfsNode>;
	trash(id: string): Promise<void>;
	permanentDelete(id: string): Promise<void>;
};

export type RemoteDriverLease = { driver: ExplorerDriver; release: () => void };

/** Ask before copying when the copy would take longer than this. */
export const REMOTE_OPEN_ASK_AFTER_MS = 3_000;
/** On a link nothing has measured yet, ask above this size. */
export const REMOTE_OPEN_UNMEASURED_ASK_BYTES = 1024 * 1024;
/** A ranged read this big measures an unmeasured link before asking. */
const PROBE_BYTES = 256 * 1024;
/**
 * Chrome's canvas area limit (16384 × 16384). A photo with more pixels than
 * this cannot be edited in the browser whatever its file size.
 */
export const MAX_EDIT_PIXELS = 16384 * 16384;
/** Top-level folder in browser files that holds working copies. */
export const REMOTE_COPIES_FOLDER = 'Remote copies';
/**
 * Working copies may use up to this much browser storage (or a quarter of
 * the site's quota, when that is less) before the least recently opened ones
 * that are safe to drop are removed. Each can be copied again on its next Open.
 */
export const REMOTE_COPIES_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

const INDEX_KEY = 'remote-copies';
const copyKey = (nodeId: string) => `remote-copy:${nodeId}`;
const sourceKey = (connectionId: string, remoteId: string) =>
	`remote-copy-src:${connectionId}|${remoteId}`;
const liveKey = (connectionId: string, remoteId: string) =>
	`remote-copy-live:${connectionId}|${remoteId}`;
const keyFor = (copy: RemoteCopy) =>
	(copy.sendBack === false ? liveKey : sourceKey)(copy.source.connectionId, copy.source.remoteId);

let vfsImpl: RemoteCopyVfs | null = null;
let resolveImpl: (connectionId: string) => Promise<RemoteDriverLease | null> = acquireRemoteDriver;
const vfs = (): RemoteCopyVfs => (vfsImpl ??= getSharedVfs() as unknown as RemoteCopyVfs);
let opStarter: typeof startOp = startOp;
/** Shown in a window somewhere: never removed to free space. */
let isOpenImpl = (nodeId: string): boolean => listWorkspaceSessions().some((s) => s.fileId === nodeId);

// ── records ─────────────────────────────────────────────────────────────

type CopyFrame = { kind: 'changed'; nodeId: string };
let bus: LiveBus<CopyFrame> | null = null;
const listeners = new Set<(nodeId: string) => void>();

function copiesBus(): LiveBus<CopyFrame> | null {
	if (bus || typeof BroadcastChannel === 'undefined') return bus;
	bus = createLiveBus<CopyFrame>(serviceNames.remoteCopiesBus, generateId('remote-copies'));
	bus.onMessage((frame) => {
		if (frame.kind === 'changed') for (const fn of listeners) fn(frame.nodeId);
	});
	return bus;
}

function announce(nodeId: string): void {
	for (const fn of listeners) fn(nodeId);
	copiesBus()?.broadcast({ kind: 'changed', nodeId });
}

/** Called with a node id whenever that copy's record changes, in any tab. */
export function onRemoteCopies(fn: (nodeId: string) => void): () => void {
	copiesBus();
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export async function getRemoteCopy(nodeId: string): Promise<RemoteCopy | undefined> {
	return vfs().getMeta<RemoteCopy>(copyKey(nodeId));
}

/** The working copy made from this remote entry, if there is one. */
export async function findRemoteCopy(connectionId: string, remoteId: string): Promise<RemoteCopy | undefined> {
	const nodeId = await vfs().getMeta<string>(sourceKey(connectionId, remoteId));
	return nodeId ? getRemoteCopy(nodeId) : undefined;
}

export async function listRemoteCopies(): Promise<RemoteCopy[]> {
	const ids = (await vfs().getMeta<string[]>(INDEX_KEY)) ?? [];
	const out: RemoteCopy[] = [];
	for (const id of ids) {
		const copy = await getRemoteCopy(id);
		if (copy) out.push(copy);
	}
	return out;
}

async function withIndexLock(fn: () => Promise<void>): Promise<void> {
	const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
	if (locks) await locks.request(serviceNames.remoteCopiesIndex, { mode: 'exclusive' }, fn);
	else await fn();
}

async function putCopy(copy: RemoteCopy): Promise<void> {
	if (copy.state !== 'sending' && copy.opId !== undefined) copy = { ...copy, opId: undefined };
	await vfs().setMeta(copyKey(copy.nodeId), copy);
	announce(copy.nodeId);
}

async function addCopy(copy: RemoteCopy): Promise<void> {
	await withIndexLock(async () => {
		const ids = (await vfs().getMeta<string[]>(INDEX_KEY)) ?? [];
		if (!ids.includes(copy.nodeId)) await vfs().setMeta(INDEX_KEY, [...ids, copy.nodeId]);
		await vfs().setMeta(keyFor(copy), copy.nodeId);
	});
	await putCopy({ ...copy, openedAt: Date.now() });
}

async function findLiveCopy(connectionId: string, remoteId: string): Promise<RemoteCopy | undefined> {
	const nodeId = await vfs().getMeta<string>(liveKey(connectionId, remoteId));
	return nodeId ? getRemoteCopy(nodeId) : undefined;
}

/** Forget a working copy. The local file stays; it just stops sending back. */
export async function dropRemoteCopy(nodeId: string): Promise<void> {
	const copy = await getRemoteCopy(nodeId);
	await withIndexLock(async () => {
		const ids = (await vfs().getMeta<string[]>(INDEX_KEY)) ?? [];
		await vfs().setMeta(INDEX_KEY, ids.filter((id) => id !== nodeId));
		if (copy) {
			const key = keyFor(copy);
			if ((await vfs().getMeta<string>(key)) === nodeId) await vfs().deleteMeta(key);
		}
		await vfs().deleteMeta(copyKey(nodeId));
	});
	announce(nodeId);
}

// ── open ────────────────────────────────────────────────────────────────

/** Another way to open a file, offered beside the copy (a PDF's first page). */
export type RemoteOpenAlternative = { id: string; label: string; detail: string };

export type RemoteOpenPlan = {
	name: string;
	label: string;
	size?: number;
	/**
	 * What happens without asking: `reuse` opens the copy already here (the
	 * remote has not changed, or this device has unsent edits), `copy` copies.
	 */
	action: 'reuse' | 'copy';
	/** The working copy `reuse` opens. */
	nodeId?: string;
	/** The copy is reused while the remote has changed too: a conflict. */
	conflict?: boolean;
	/** Estimated copy time; `undefined` when the link is unmeasured. */
	copyMs?: number;
	/** Ask before copying (slow or unmeasured link). */
	ask: boolean;
	/** The file cannot be opened for editing here, and why. */
	blocked?: string;
	/** Pixel size, for a photo. */
	pixels?: { width: number; height: number };
};

function connectionLabel(driver: ExplorerDriver): string {
	return driver.label?.trim() || (driver.id === 'b2' ? 'B2' : 'the monitor');
}

function remoteUnchanged(copy: RemoteCopy, entry: ExplorerEntry): boolean {
	if (entry.updatedAt !== undefined && copy.base.updatedAt !== entry.updatedAt) return false;
	if (entry.size !== undefined && copy.base.size !== undefined && copy.base.size !== entry.size) return false;
	return true;
}

/** Measure an unmeasured link with a short ranged read of this very file. */
async function probeLink(driver: ExplorerDriver, entry: ExplorerEntry): Promise<void> {
	const loc = await driver.rangeUrl?.(entry.id).catch(() => null);
	if (!loc?.url || linkBytesPerSecond(loc.url) !== undefined) return;
	const end = Math.min(entry.size ?? PROBE_BYTES, PROBE_BYTES) - 1;
	if (end < 0) return;
	await fetchByteRange(loc.url, 0, end).catch(() => undefined);
}

async function linkUrlOf(driver: ExplorerDriver, entry: ExplorerEntry): Promise<string | undefined> {
	const loc = await driver.rangeUrl?.(entry.id).catch(() => null);
	if (loc?.url) return loc.url;
	const dl = await driver.downloadUrl?.(entry.id).catch(() => null);
	return dl?.url;
}

/**
 * What opening `entry` would do. Reads nothing big: at most a 256 KiB range to
 * measure an unmeasured link, and an image header for a photo's pixel size.
 */
export async function planRemoteOpen(
	driver: ExplorerDriver,
	entry: ExplorerEntry,
	opts?: { image?: boolean }
): Promise<RemoteOpenPlan> {
	const label = connectionLabel(driver);
	const base: Pick<RemoteOpenPlan, 'name' | 'label' | 'size'> = { name: entry.name, label, size: entry.size };
	const connectionId = driver.connectionId;
	if (connectionId) {
		const existing = await findRemoteCopy(connectionId, entry.id);
		const node = existing ? await vfs().get(existing.nodeId) : undefined;
		if (existing && node && node.deletedAt == null) {
			const unsent = node.generation > existing.syncedGeneration || existing.state === 'conflict';
			if (remoteUnchanged(existing, entry)) return { ...base, action: 'reuse', nodeId: existing.nodeId, ask: false };
			// Both changed: open this device's edits and say so; never drop them.
			if (unsent) return { ...base, action: 'reuse', nodeId: existing.nodeId, conflict: true, ask: false };
		}
	}

	let pixels: RemoteOpenPlan['pixels'];
	if (opts?.image && driver.imageInfo) {
		const info = await driver.imageInfo(entry.id).catch(() => null);
		if (info) {
			pixels = { width: info.width, height: info.height };
			if (info.width * info.height > MAX_EDIT_PIXELS) {
				return {
					...base,
					action: 'copy',
					ask: true,
					pixels,
					blocked: `This photo is ${info.width.toLocaleString()} × ${info.height.toLocaleString()} pixels, more than an editor in the browser can hold.`
				};
			}
		}
	}

	if (entry.size !== undefined && typeof navigator !== 'undefined' && navigator.storage?.estimate) {
		const est = await navigator.storage.estimate().catch(() => null);
		if (est?.quota !== undefined && est.usage !== undefined && entry.size > est.quota - est.usage) {
			return { ...base, action: 'copy', ask: true, pixels, blocked: 'There is not enough browser storage on this device for a copy.' };
		}
	}

	const size = entry.size ?? 0;
	let url = await linkUrlOf(driver, entry);
	if (url && linkBytesPerSecond(url) === undefined && size > REMOTE_OPEN_UNMEASURED_ASK_BYTES) {
		await probeLink(driver, entry);
		url = await linkUrlOf(driver, entry);
	}
	const copyMs = url ? estimateTransferMs(url, size) : undefined;
	const ask =
		copyMs !== undefined ? copyMs > REMOTE_OPEN_ASK_AFTER_MS : size > REMOTE_OPEN_UNMEASURED_ASK_BYTES;
	return { ...base, action: 'copy', copyMs, ask, pixels };
}

function endpointOf(driver: ExplorerDriver): Endpoint {
	return { kind: driver.id === 'b2' ? 'b2' : 'monitor', label: connectionLabel(driver) };
}

const THIS_BROWSER: Endpoint = { kind: 'browser', label: 'This browser' };

const folderName = (raw: string) => raw.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Remote';

async function childFolder(parentId: string | null, name: string): Promise<string> {
	const fs = vfs();
	const hit = await fs.childByName(parentId, name);
	return (hit && hit.kind === 'folder' && hit.deletedAt == null ? hit : await fs.mkdir(parentId, name)).id;
}

/**
 * `Remote copies/<connection>/`, or for a page opened live its own folder
 * inside that: Documents treats a page's folder as its workspace, so a live
 * page must not share one with unrelated copies.
 */
async function copiesFolder(label: string, live?: string): Promise<string> {
	const connection = await childFolder(await childFolder(null, REMOTE_COPIES_FOLDER), folderName(label));
	return live ? childFolder(connection, `${folderName(live.replace(/\.[^.]+$/, ''))} (live)`) : connection;
}

async function beginOp(input: Parameters<typeof startOp>[0]): Promise<OpHandle | null> {
	try {
		return await opStarter(input);
	} catch (error) {
		// The record reports the transfer; it never gates one.
		console.error('Could not record operation; continuing without it', error);
		return null;
	}
}

/**
 * Copy `entry` into browser files and record it as a working copy. Streams;
 * the file never sits in memory whole. Returns the local node id.
 */
export async function copyRemoteForOpen(
	driver: ExplorerDriver,
	entry: ExplorerEntry,
	opts?: {
		windowId?: string;
		signal?: AbortSignal;
		/**
		 * `false` copies without sending Saves back: for a document opened live
		 * on its monitor, where the monitor's room keeps the file and a send
		 * would only collide with it.
		 */
		track?: boolean;
	}
): Promise<string> {
	const track = opts?.track !== false;
	const connectionId = driver.connectionId;
	if (!connectionId) throw new Error('This location cannot be opened here');
	if (!driver.openDownloadStream) throw new Error('This location cannot send files to this browser');
	const label = connectionLabel(driver);
	const previous = track
		? await findRemoteCopy(connectionId, entry.id)
		: await findLiveCopy(connectionId, entry.id);
	if (!track && previous) {
		// A live page's copy only seeds the editor; the newest one replaces it
		// so the page's folder holds that page alone.
		await retireCopy(previous.nodeId);
	}
	const folderId = await copiesFolder(label, track ? undefined : entry.name);
	const name = await vfs().ensureUniqueName(folderId, entry.name);
	const controller = new AbortController();
	opts?.signal?.addEventListener('abort', () => controller.abort(opts.signal?.reason), { once: true });
	const op = await beginOp({
		id: generateId('open-copy'),
		kind: 'open-copy',
		app: 'files',
		title: entry.name,
		windowId: opts?.windowId,
		where: { executor: 'this-browser', from: endpointOf(driver), to: THIS_BROWSER },
		landing: { kind: 'vfs-folder', folderId, name },
		signal: controller.signal
	});
	op?.onCancelRequest(() => controller.abort());
	try {
		const { stream, contentType } = await driver.openDownloadStream(entry.id, {
			signal: controller.signal,
			onProgress: (done, total) => op?.progress({ done, total: total ?? entry.size })
		});
		const node = await vfs().writeFileStream(
			{ parentId: folderId, name, contentType: entry.contentType ?? contentType },
			stream,
			{ signal: controller.signal }
		);
		if (track && previous && previous.nodeId !== node.id) {
			// The remote moved on and this device had nothing unsent: the new
			// copy replaces the old one.
			await retireCopy(previous.nodeId);
		}
		await addCopy({
			nodeId: node.id,
			source: { connectionId, driverId: driver.id, remoteId: entry.id, label, name: entry.name },
			base: { updatedAt: entry.updatedAt, size: entry.size ?? node.size },
			syncedGeneration: node.generation,
			state: 'synced',
			...(track ? {} : { sendBack: false as const })
		});
		await op?.done({ kind: 'vfs-file', fileId: node.id, name: node.name }, true);
		await trimRemoteCopies({ keep: node.id }).catch((error) =>
			console.error('Could not free space from working copies', error)
		);
		return node.id;
	} catch (error) {
		if (controller.signal.aborted) await op?.cancelled();
		else await op?.fail(error);
		throw error;
	}
}

/**
 * A copy a newer one replaced. It held nothing unsent, so it is deleted for
 * good, freeing its space at once; a copy a window still shows goes to the
 * trash instead, so that window keeps its file until it moves on.
 */
async function retireCopy(nodeId: string): Promise<void> {
	await dropRemoteCopy(nodeId);
	if (isOpenImpl(nodeId)) {
		await vfs().trash(nodeId).catch(() => {});
		return;
	}
	await vfs()
		.permanentDelete(nodeId)
		.catch(() => vfs().trash(nodeId).catch(() => {}));
}

/**
 * The open half of a remote Open, after the person agreed (or was not asked):
 * reuse the copy here or make one. Marks a reused copy `conflict` when the
 * remote changed under this device's unsent edits.
 */
export async function openRemoteWorkingCopy(
	driver: ExplorerDriver,
	entry: ExplorerEntry,
	plan: RemoteOpenPlan,
	opts?: { windowId?: string; signal?: AbortSignal }
): Promise<string> {
	const reused = plan.action === 'reuse' && plan.nodeId ? await getRemoteCopy(plan.nodeId) : undefined;
	const reusedNode = reused ? await vfs().get(reused.nodeId) : undefined;
	// Space may have been freed since the plan was made: copy again then.
	if (reused && reusedNode && reusedNode.deletedAt == null) {
		await putCopy({
			...reused,
			openedAt: Date.now(),
			...(plan.conflict && reused.state !== 'conflict'
				? { state: 'conflict' as const, error: `Changed on ${reused.source.label} and on this device` }
				: {})
		});
		return reused.nodeId;
	}
	return copyRemoteForOpen(driver, entry, opts);
}

// ── send back ───────────────────────────────────────────────────────────

/**
 * A driver for a saved connection by its id, held until `release`. `null` when
 * the connection is no longer saved on this device.
 */
export async function acquireRemoteDriver(connectionId: string): Promise<RemoteDriverLease | null> {
	if (connectionId.startsWith('monitor:')) {
		const profile = await getProfile(connectionId.slice('monitor:'.length));
		if (!profile) return null;
		const driver = await acquireMonitorDriver(profile);
		return { driver, release: () => releaseMonitorDriver(profile.id) };
	}
	if (connectionId.startsWith('b2:')) {
		const row = await getB2Connection(connectionId.slice('b2:'.length));
		if (!row) return null;
		const driver = await acquireB2Driver(row);
		return { driver, release: () => releaseB2Driver(row.rowId) };
	}
	return null;
}

const queued = new Set<string>();

function siblingId(remoteId: string, name: string): string {
	const slash = remoteId.lastIndexOf('/');
	return `${slash >= 0 ? remoteId.slice(0, slash + 1) : ''}${name}`;
}

function withSuffix(name: string, suffix: string): string {
	const dot = name.lastIndexOf('.');
	return dot > 0 ? `${name.slice(0, dot)} ${suffix}${name.slice(dot)}` : `${name} ${suffix}`;
}

async function withCopyLock(nodeId: string, fn: () => Promise<void>): Promise<void> {
	const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
	if (locks) await locks.request(serviceNames.remoteCopy(nodeId), { mode: 'exclusive' }, fn);
	else await fn();
}

/**
 * Send the copy's newest saved generation back, if it has one the remote
 * lacks. `mode` resolves a conflict: `overwrite` replaces the remote anyway,
 * `new-file` writes beside it and follows that file from then on.
 */
export async function sendRemoteCopy(
	nodeId: string,
	mode?: 'overwrite' | 'new-file'
): Promise<void> {
	await withCopyLock(nodeId, async () => {
		let force = mode;
		for (;;) {
			const copy = await getRemoteCopy(nodeId);
			if (!copy || copy.sendBack === false) return;
			const node = await vfs().get(nodeId);
			if (!node || node.deletedAt != null) return;
			if (!force) {
				if (copy.state === 'conflict') return;
				if (node.generation <= copy.syncedGeneration) {
					// Up to date. A `sending` mark left by a tab that died
					// mid-send is cleared here: its lock came to us.
					if (copy.state !== 'synced') await putCopy({ ...copy, state: 'synced', error: undefined });
					return;
				}
			}
			const sent = await sendOnce(copy, node, force);
			if (!sent) return;
			force = undefined;
		}
	});
}

async function sendOnce(
	copy: RemoteCopy,
	node: VfsNode,
	mode: 'overwrite' | 'new-file' | undefined
): Promise<boolean> {
	const generation = node.generation;
	const lease = await resolveImpl(copy.source.connectionId).catch(() => null);
	if (!lease?.driver.writeBack) {
		await putCopy({
			...copy,
			state: 'failed',
			failedGeneration: generation,
			error: lease ? `${copy.source.label} cannot take files back` : `${copy.source.label} is not connected`
		});
		lease?.release();
		return false;
	}
	let target = copy.source;
	if (mode === 'new-file') {
		const slash = copy.source.remoteId.lastIndexOf('/');
		const parentId = slash >= 0 ? copy.source.remoteId.slice(0, slash + 1) : null;
		const wanted = withSuffix(copy.source.name, '(this device)');
		const name = lease.driver.uniqueName
			? await lease.driver.uniqueName(parentId, wanted).catch(() => wanted)
			: wanted;
		target = { ...copy.source, name, remoteId: siblingId(copy.source.remoteId, name) };
	}
	const opId = generateId('save-back');
	const op = await beginOp({
		id: opId,
		kind: 'save-back',
		app: 'files',
		title: node.name,
		where: { executor: 'this-browser', from: THIS_BROWSER, to: endpointOf(lease.driver) }
	});
	await putCopy({ ...copy, state: 'sending', error: undefined, opId: op ? opId : undefined });
	try {
		const body = await vfs().readBlob(node.id);
		const result = await lease.driver.writeBack(target.remoteId, body, {
			expectUpdatedAt: mode ? undefined : copy.base.updatedAt,
			signal: op?.signal,
			onProgress: (done, total) => op?.progress({ done, total: total ?? body.size })
		});
		const next: RemoteCopy = {
			nodeId: copy.nodeId,
			source: target,
			base: { updatedAt: result.updatedAt, size: result.size ?? body.size },
			syncedGeneration: generation,
			state: 'synced'
		};
		if (target.remoteId !== copy.source.remoteId) {
			await withIndexLock(async () => {
				const oldKey = sourceKey(copy.source.connectionId, copy.source.remoteId);
				if ((await vfs().getMeta<string>(oldKey)) === copy.nodeId) await vfs().setMeta(oldKey, undefined);
				await vfs().setMeta(sourceKey(target.connectionId, target.remoteId), copy.nodeId);
			});
		}
		await putCopy(next);
		await op?.done();
		return true;
	} catch (error) {
		if (error instanceof RemoteChangedError) {
			await putCopy({ ...copy, state: 'conflict', error: `Changed on ${copy.source.label} since this copy was made` });
			await op?.fail(`Not sent: ${copy.source.name} changed on ${copy.source.label}`);
		} else {
			const cancelled = op?.signal.aborted === true;
			await putCopy({
				...copy,
				state: 'failed',
				failedGeneration: generation,
				error: cancelled ? 'Sending was cancelled' : error instanceof Error ? error.message : String(error)
			});
			if (cancelled) await op?.cancelled();
			else await op?.fail(error);
		}
		return false;
	} finally {
		lease.release();
	}
}

/**
 * Free browser storage held by working copies above the budget: remove the
 * least recently opened copies that are safe to drop (nothing unsent, not in
 * conflict, not shown in any window). Each one comes back on its next Open.
 * Returns the removed node ids.
 */
export async function trimRemoteCopies(opts?: { keep?: string; budget?: number }): Promise<string[]> {
	let budget = opts?.budget ?? REMOTE_COPIES_BUDGET_BYTES;
	if (opts?.budget === undefined && typeof navigator !== 'undefined' && navigator.storage?.estimate) {
		const quota = (await navigator.storage.estimate().catch(() => null))?.quota;
		if (quota) budget = Math.min(budget, quota / 4);
	}
	const rows: Array<{ copy: RemoteCopy; node: VfsNode }> = [];
	for (const copy of await listRemoteCopies()) {
		const node = await vfs().get(copy.nodeId);
		if (!node) {
			await dropRemoteCopy(copy.nodeId);
			continue;
		}
		if (node.deletedAt == null) rows.push({ copy, node });
	}
	let total = rows.reduce((sum, r) => sum + (r.node.size ?? 0), 0);
	if (total <= budget) return [];
	const droppable = rows
		.filter(({ copy, node }) =>
			copy.nodeId !== opts?.keep &&
			(copy.sendBack === false ||
				(copy.state === 'synced' && node.generation <= copy.syncedGeneration)) &&
			!isOpenImpl(copy.nodeId)
		)
		.sort((a, b) => (a.copy.openedAt ?? 0) - (b.copy.openedAt ?? 0));
	const removed: string[] = [];
	for (const { copy, node } of droppable) {
		if (total <= budget) break;
		try {
			await vfs().permanentDelete(copy.nodeId);
		} catch {
			continue;
		}
		await dropRemoteCopy(copy.nodeId);
		total -= node.size ?? 0;
		removed.push(copy.nodeId);
	}
	return removed;
}

/** Retry a failed send now (the status menu's Retry). */
export async function retryRemoteCopy(nodeId: string): Promise<void> {
	const copy = await getRemoteCopy(nodeId);
	if (copy?.state === 'failed') await putCopy({ ...copy, failedGeneration: undefined });
	await sendRemoteCopy(nodeId);
}

async function scan(): Promise<void> {
	for (const copy of await listRemoteCopies()) {
		if (queued.has(copy.nodeId) || copy.state === 'conflict' || copy.sendBack === false) continue;
		const node = await vfs().get(copy.nodeId);
		// Deleted for good (an emptied trash): nothing left to send or keep.
		if (!node) {
			await dropRemoteCopy(copy.nodeId);
			continue;
		}
		if (node.deletedAt != null) continue;
		const due =
			node.generation > copy.syncedGeneration &&
			!(copy.state === 'failed' && node.generation <= (copy.failedGeneration ?? 0));
		// `sending` with nothing due: a tab may have died mid-send. Queueing on
		// the lock is how this tab finds out (it is granted once that tab is gone).
		if (!due && copy.state !== 'sending') continue;
		queued.add(copy.nodeId);
		void sendRemoteCopy(copy.nodeId)
			.catch((error) => console.error('Could not send a working copy back', error))
			.finally(() => queued.delete(copy.nodeId));
	}
}

let stopSync: (() => void) | null = null;
let scanning = false;
let rescan = false;

async function runScan(): Promise<void> {
	if (scanning) {
		rescan = true;
		return;
	}
	scanning = true;
	try {
		do {
			rescan = false;
			await scan();
		} while (rescan);
	} catch (error) {
		console.error('Could not check working copies', error);
	} finally {
		scanning = false;
	}
}

/**
 * Send saved working copies back from this tab. Idempotent: every window may
 * call it. A Save in any tab bumps the copy's generation and wakes every tab;
 * the copy's lock lets one of them send.
 */
export function startRemoteCopySync(): () => void {
	if (stopSync) return stopSync;
	const unsubscribe = vfs().subscribe(() => void runScan());
	void runScan();
	stopSync = () => {
		unsubscribe();
		stopSync = null;
	};
	return stopSync;
}

export function setRemoteCopiesForTest(next: {
	vfs?: RemoteCopyVfs;
	resolveDriver?: (connectionId: string) => Promise<RemoteDriverLease | null>;
	startOp?: typeof startOp;
	isOpen?: (nodeId: string) => boolean;
}): void {
	stopSync?.();
	isOpenImpl = next.isOpen ?? ((nodeId) => listWorkspaceSessions().some((s) => s.fileId === nodeId));
	vfsImpl = next.vfs ?? null;
	resolveImpl = next.resolveDriver ?? acquireRemoteDriver;
	opStarter = next.startOp ?? startOp;
	listeners.clear();
	queued.clear();
	bus?.destroy();
	bus = null;
}

// ── the Open flow ───────────────────────────────────────────────────────

export type RemoteOpenChoice = 'copy' | 'cancel' | { alternative: string };

export type RemoteOpenOutcome =
	| { kind: 'opened'; nodeId: string; conflict: boolean }
	| { kind: 'cancelled' }
	| { kind: 'alternative'; id: string };

/**
 * Everything Files does when a monitor or B2 file is opened, in one place:
 * plan, ask when there is a choice (a slow copy, a file that cannot open
 * here, another way to open it), then copy or reuse the working copy and hand
 * the local file to `open`. The prompt and the app are the caller's.
 */
export async function runRemoteOpen(args: {
	driver: ExplorerDriver;
	entry: ExplorerEntry;
	image?: boolean;
	windowId?: string;
	alternativesFor?: (entry: ExplorerEntry, driver: ExplorerDriver, plan: RemoteOpenPlan) => RemoteOpenAlternative[];
	ask: (plan: RemoteOpenPlan, alternatives: RemoteOpenAlternative[]) => Promise<RemoteOpenChoice>;
	onAlternative?: (id: string, entry: ExplorerEntry, driver: ExplorerDriver) => void | Promise<void>;
	open: (node: VfsNode) => void | Promise<void>;
}): Promise<RemoteOpenOutcome> {
	const { driver, entry } = args;
	const plan = await planRemoteOpen(driver, entry, { image: args.image });
	const alternatives = plan.blocked ? [] : (args.alternativesFor?.(entry, driver, plan) ?? []);
	if (plan.ask || plan.blocked || alternatives.length > 0) {
		const choice = await args.ask(plan, alternatives);
		if (choice === 'cancel' || plan.blocked) return { kind: 'cancelled' };
		if (choice !== 'copy') {
			await args.onAlternative?.(choice.alternative, entry, driver);
			return { kind: 'alternative', id: choice.alternative };
		}
	}
	const nodeId = await openRemoteWorkingCopy(driver, entry, plan, { windowId: args.windowId });
	const node = await vfs().get(nodeId);
	if (!node || node.deletedAt != null) throw new Error('The copy is no longer in browser files');
	await args.open(node);
	return { kind: 'opened', nodeId, conflict: plan.conflict === true };
}
