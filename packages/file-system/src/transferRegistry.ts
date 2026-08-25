/**
 * Central, app-global in-flight transfer registry.
 *
 * Transport-agnostic: tracks active and recently-completed transfers (progress,
 * direction, integrity, SHA-256) plus retained blobs for the session UI. The
 * actual transport (WebRTC, chunking, resume) lives in the consuming app and
 * reports into this registry. Any part of the app can subscribe / list.
 *
 * Received files are ALSO written to the central in-memory VFS by the consumer
 * (see memoryVfs) so they are accessible app-wide; this registry holds the
 * transient transfer metadata + a short-lived blob for the transfer-queue UI.
 *
 * Cap: 512 MiB of retained completed blobs; auto-evict oldest completed first.
 * Per-tab only (module realm).
 */
import type { MemoryVfsService } from './memoryVfs.js';

export type TransferIntegrity = 'pending' | 'ok' | 'mismatch' | 'skipped';
export type TransferDirection = 'sending' | 'receiving' | 'copying';
export type TransferStatus = 'hashing' | 'active' | 'done' | 'failed' | 'incomplete';
/** Which copy-across system is moving bytes (progress popup hop label). */
export type CopyHop = 'server' | 'delegated' | 'webrtc' | 'dual-phase' | 'direct';
export type CopyIce = 'checking' | 'connected' | 'failed';
export type CopyIcePath = 'host' | 'stun';

export interface TransferProgress {
	id: string;
	name: string;
	size: number;
	transferred: number;
	direction: TransferDirection;
	done: boolean;
	sha256?: string;
	/** Digest algorithm for `sha256` (e.g. 'blake3', 'sha256'). */
	hashAlg?: string;
	integrity?: TransferIntegrity;
	status?: TransferStatus;
	error?: string;
	resumed?: boolean;
	parallelStreams?: number;
	hop?: CopyHop;
	ice?: CopyIce;
	icePath?: CopyIcePath;
	hopNote?: string;
}

export interface ReceivedFile {
	id: string;
	name: string;
	/** Neutrally typed — safe to expose as an object URL. */
	blob: Blob;
	url: string;
	size: number;
	sha256?: string;
	integrity: TransferIntegrity;
	/** Peer-declared type, carried as metadata rather than on the blob itself. */
	contentType?: string;
}

export interface TransferItem {
	id: string;
	name: string;
	size: number;
	direction: TransferDirection;
	status: TransferStatus;
	transferred: number;
	done: boolean;
	integrity?: TransferIntegrity;
	sha256?: string;
	/** Digest algorithm for `sha256` (e.g. 'blake3', 'sha256'). */
	hashAlg?: string;
	blob?: Blob;
	url?: string;
	contentType?: string;
	error?: string;
	resumed?: boolean;
	parallelStreams?: number;
	hop?: CopyHop;
	ice?: CopyIce;
	icePath?: CopyIcePath;
	hopNote?: string;
	completedAt?: number;
	savedToLibrary?: {
		nodeId: string;
		savedAt: number;
		mode: 'copy' | 'move';
	};
}

/** Cumulative RAM cap for retained completed blobs (design: 512 MiB). */
export const TRANSFER_BLOB_CAP_BYTES = 512 * 1024 * 1024;

type Listener = () => void;

const items = new Map<string, TransferItem>();
const listeners = new Set<Listener>();
/** Pending sent File blobs keyed by progress id (attached when send completes). */
const pendingSentFiles = new Map<string, File>();
/** Files enqueued for send before progress id is known. */
const pendingSendQueue: File[] = [];

let lastEvictionToast = false;

function notify(): void {
	for (const l of listeners) l();
}

export function subscribeTransfers(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function listTransfers(): TransferItem[] {
	return [...items.values()];
}

export function getTransfer(id: string): TransferItem | undefined {
	return items.get(id);
}

/** Bytes of retained completed blobs currently held in the store. */
export function transferBlobBytes(): number {
	let total = 0;
	for (const item of items.values()) {
		if (item.blob && item.done) total += item.blob.size;
	}
	return total;
}

/** True if the last upsert/setReceived triggered an eviction (UI can toast once). */
export function consumeEvictionFlag(): boolean {
	const v = lastEvictionToast;
	lastEvictionToast = false;
	return v;
}

function isCompletedWithBlob(item: TransferItem): boolean {
	return !!(item.done && item.blob);
}

/** Evict oldest completed items until under cap. Never evicts in-flight. */
function enforceCap(): void {
	let total = transferBlobBytes();
	if (total <= TRANSFER_BLOB_CAP_BYTES) return;

	const completed = [...items.values()]
		.filter(isCompletedWithBlob)
		.sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));

	for (const item of completed) {
		if (total <= TRANSFER_BLOB_CAP_BYTES) break;
		const size = item.blob?.size ?? 0;
		revokeItemBlob(item);
		item.blob = undefined;
		item.url = undefined;
		// Keep row as metadata-only after eviction
		items.set(item.id, { ...item });
		total -= size;
		lastEvictionToast = true;
	}
}

function revokeItemBlob(item: TransferItem): void {
	if (item.url) {
		try {
			URL.revokeObjectURL(item.url);
		} catch {
			/* ignore */
		}
	}
}

/**
 * Enqueue a File about to be sent so we can retain it when progress reports
 * an id (symmetric sent retention).
 */
export function enqueueSentFile(file: File): void {
	pendingSendQueue.push(file);
}

function bindPendingSentFile(progress: TransferProgress): void {
	if (progress.direction !== 'sending') return;
	if (pendingSentFiles.has(progress.id)) return;
	if (pendingSendQueue.length === 0) return;
	let idx = pendingSendQueue.findIndex(
		(f) => f.name === progress.name && f.size === progress.size
	);
	if (idx < 0) idx = 0;
	const [file] = pendingSendQueue.splice(idx, 1);
	if (file) pendingSentFiles.set(progress.id, file);
}

export function upsertProgress(progress: TransferProgress): TransferItem {
	bindPendingSentFile(progress);
	const prev = items.get(progress.id);
	const next: TransferItem = {
		id: progress.id,
		name: progress.name,
		size: progress.size,
		direction: progress.direction,
		status: progress.status ?? prev?.status ?? 'active',
		transferred: progress.transferred,
		done: progress.done,
		integrity: progress.integrity ?? prev?.integrity,
		sha256: progress.sha256 ?? prev?.sha256,
		hashAlg: progress.hashAlg ?? prev?.hashAlg,
		blob: prev?.blob,
		url: prev?.url,
		contentType: prev?.contentType,
		error: progress.error ?? (progress.status === 'failed' ? prev?.error : undefined),
		resumed: progress.resumed ?? prev?.resumed,
		parallelStreams: progress.parallelStreams ?? prev?.parallelStreams,
		hop: progress.hop ?? prev?.hop,
		ice: progress.ice ?? prev?.ice,
		icePath: progress.icePath ?? prev?.icePath,
		hopNote: progress.hopNote ?? prev?.hopNote,
		completedAt: prev?.completedAt,
		savedToLibrary: prev?.savedToLibrary
	};

	// Attach retained sent blob when send finishes
	if (
		progress.direction === 'sending' &&
		progress.done &&
		!next.blob &&
		pendingSentFiles.has(progress.id)
	) {
		const file = pendingSentFiles.get(progress.id)!;
		pendingSentFiles.delete(progress.id);
		next.blob = file;
		next.url = URL.createObjectURL(file);
		next.contentType = file.type || undefined;
		next.completedAt = Date.now();
	} else if (progress.done && !next.completedAt) {
		next.completedAt = Date.now();
	}

	if (progress.status === 'failed' || progress.integrity === 'mismatch') {
		pendingSentFiles.delete(progress.id);
	}

	items.set(progress.id, next);
	if (next.done && next.blob) enforceCap();
	notify();
	return next;
}

export function setReceived(file: ReceivedFile): TransferItem {
	const prev = items.get(file.id);
	const next: TransferItem = {
		id: file.id,
		name: file.name,
		size: file.size,
		direction: 'receiving',
		status: file.integrity === 'mismatch' ? 'failed' : 'done',
		transferred: file.size,
		done: true,
		integrity: file.integrity,
		sha256: file.sha256,
		blob: file.blob,
		url: file.url,
		contentType: file.contentType || file.blob.type || undefined,
		error: file.integrity === 'mismatch' ? prev?.error : undefined,
		resumed: prev?.resumed,
		parallelStreams: prev?.parallelStreams,
		completedAt: Date.now(),
		savedToLibrary: prev?.savedToLibrary
	};
	// Avoid leaking previous object URL if different
	if (prev?.url && prev.url !== file.url) {
		revokeItemBlob(prev);
	}
	items.set(file.id, next);
	enforceCap();
	notify();
	return next;
}

export function markSaved(
	id: string,
	nodeId: string,
	mode: 'copy' | 'move'
): TransferItem | undefined {
	const item = items.get(id);
	if (!item) return undefined;
	const next: TransferItem = {
		...item,
		savedToLibrary: { nodeId, savedAt: Date.now(), mode }
	};
	if (mode === 'move') {
		revokeItemBlob(next);
		next.blob = undefined;
		next.url = undefined;
	}
	items.set(id, next);
	notify();
	return next;
}

export function revokeTransferBlob(id: string): void {
	const item = items.get(id);
	if (!item) return;
	revokeItemBlob(item);
	items.set(id, { ...item, blob: undefined, url: undefined });
	notify();
}

export function removeTransfer(id: string): void {
	const item = items.get(id);
	if (!item) return;
	revokeItemBlob(item);
	items.delete(id);
	pendingSentFiles.delete(id);
	notify();
}

/** Revoke all object URLs and clear the registry (page leave / hard reset). */
export function revokeAllTransfers(): void {
	for (const item of items.values()) {
		revokeItemBlob(item);
	}
	items.clear();
	pendingSentFiles.clear();
	pendingSendQueue.length = 0;
	lastEvictionToast = false;
	notify();
}

/**
 * Convenience for receive handlers: record the completed receive in the registry
 * AND persist the file into the central in-memory VFS so it is app-wide
 * accessible. Returns the registry item and the memory-VFS node id.
 *
 * Callers that only want registry tracking (no VFS write) should use
 * `setReceived` directly.
 */
export async function receiveToMemoryVfs(
	file: ReceivedFile,
	vfs: MemoryVfsService,
	opts?: { contentType?: string; meta?: Record<string, unknown> }
): Promise<{ item: TransferItem; nodeId: string }> {
	const item = setReceived(file);
	const node = await vfs.writeFile({
		parentId: null,
		name: file.name,
		body: file.blob,
		contentType: opts?.contentType ?? file.contentType ?? file.blob.type ?? undefined,
		meta: {
			source: 'transfer',
			transferId: file.id,
			sha256: file.sha256,
			integrity: file.integrity,
			...(opts?.meta ?? {})
		}
	});
	return { item, nodeId: node.id };
}

/** Test helper: reset registry completely. */
export function resetTransferRegistryForTests(): void {
	revokeAllTransfers();
}