/**
 * Transfer row shapes shared by the file manager (progress reporting into
 * ops, stacked progress) and the Connections transfer cache
 * (`transferRegistry.ts`). Types only: the file manager reports into ops
 * (platform-services W4.7) and never touches the cache.
 */
export type TransferIntegrity = 'pending' | 'ok' | 'mismatch' | 'skipped';
export type TransferDirection = 'sending' | 'receiving' | 'copying';
export type TransferStatus = 'hashing' | 'active' | 'done' | 'failed' | 'cancelled' | 'incomplete';
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
	/** Destination folder for an explorer copy row. */
	destParentId?: string | null;
	entryKind?: 'file' | 'folder';
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
	destParentId?: string | null;
	entryKind?: 'file' | 'folder';
	completedAt?: number;
	savedToLibrary?: {
		nodeId: string;
		savedAt: number;
		mode: 'copy' | 'move';
	};
}
