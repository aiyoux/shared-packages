import { blockChildren, documentOrder, findBlock } from './tree.js';
import type { Block, KbPage, Op } from './types.js';
import type { StickyPoint } from './mapPoint.js';

export type { Assoc, StickyPoint } from './mapPoint.js';

export type AwarenessState = {
	user: { name: string; color: string };
	caret: { anchor: StickyPoint; head: StickyPoint } | null;
	composing?: boolean;
	/** Opaque room id assigned at `hello`. Not `VfsNode.id`. */
	roomId: string;
};

export type CollabRole = 'sequencer' | 'replica';

export type CollabFrame =
	| { kind: 'hello'; pageId: string; schemaVersion: number; clientId: string; role: CollabRole; roomId: string }
	| {
			kind: 'snapshot';
			pageId: string;
			seq: number;
			page: KbPage;
			/** Join / nack / resync replace the editor. CAS persist echoes omit this. */
			reason?: 'join' | 'nack' | 'resync';
	  }
	| {
			kind: 'ops';
			pageId: string;
			clientId: string;
			clientOpId: string;
			baseSeq: number;
			seq: number;
			ops: Op[];
	  }
	| { kind: 'ack'; clientOpId: string; seq: number }
	/** v1: no opsSince. Replica waits for localSeq === headSeq then replace-from-snapshot. */
	| { kind: 'nack'; clientOpId: string; headSeq: number }
	| { kind: 'resync'; pageId: string; reason: string }
	| { kind: 'presence'; clientId: string; state: AwarenessState | null }
	| { kind: 'schema-mismatch'; local: number; remote: number }
	/**
	 * Asset bytes travel as SESSION content, never as durable identity — a
	 * replica asks for a `src` its own store cannot resolve, the peer answers
	 * with chunked bytes (docs/design/kb-ephemeral-join.md §5). Purely
	 * transport-level: no op semantics, no persistence, no undo. The chunk
	 * framing is the frame's own (`index`/`total` over base64 `chunk`s) — the
	 * envelope `seq` is NOT involved: the checkpoint line reads `frame.seq`
	 * for op ordering, and asset frames must never mean two things there.
	 */
	| { kind: 'asset-request'; pageId: string; clientId: string; roomId?: string; srcs: string[] }
	| {
			kind: 'asset';
			pageId: string;
			clientId: string;
			roomId?: string;
			/** Opaque source key as it appears on the page (e.g. `assets/<file>`). */
			src: string;
			/** Content fingerprint — the receiver skips an unchanged re-push. */
			hash: string;
			/** 0-based; `index === total - 1` completes the payload. */
			index: number;
			total: number;
			/** base64 chunk of the asset's bytes. */
			chunk: string;
	  };

/** Wire wrapper so CM dispatch is one `msg.type` branch. */
export type KbCollabMessage = { type: 'kb-collab'; v: 1; frame: CollabFrame };

export type CollabSessionOpts = {
	/** 'cm' = WebRTC peer, 'monitor' = SSE, 'tab' = another tab of this browser. */
	kind: 'cm' | 'monitor' | 'tab';
	role: CollabRole;
	pageId: string;
	/** This client's max understood (`KB_SCHEMA_VERSION`), not the file version. */
	schemaVersion: number;
	clientId: string;
};

export interface CollabSession {
	readonly kind: 'cm' | 'monitor' | 'tab';
	readonly role: CollabRole;
	readonly pageId: string;
	readonly clientId: string;
	/** This client's max understood (capability). */
	readonly schemaVersion: number;
	readonly ready: Promise<void>;
	/**
	 * Put a frame on this transport as it stands.
	 *
	 * The frame-uniform path, and the reason it exists: a RELAY has to forward
	 * what arrived on one transport to another without knowing what it is.
	 * Every adapter already had this privately — `tabCollab`, `hubClient` and
	 * `cmCollab` all declared their own `sendFrame` and the runtime reached it
	 * through a structural cast — so this hoists an existing contract rather
	 * than inventing one.
	 *
	 * Not a replacement for the typed senders below. The monitor adapter cannot
	 * pass a frame through: its `sendOps` POSTs, tracks its own `baseSeq`, and
	 * recovers from a nack, so a frame's own `baseSeq` is meaningless to it. It
	 * implements this by DISPATCHING to the typed methods, which is correct and
	 * is why they stay.
	 */
	sendFrame(frame: CollabFrame): void;
	sendOps(ops: Op[], clientOpId: string, baseSeq: number): Promise<void>;
	sendPresence(state: AwarenessState | null): void;
	/**
	 * Sequencer → replicas only (`kind: 'snapshot'` on the wire).
	 * Persist is **not** this method — see `MonitorCollabAdapter.submitPage`.
	 * A replica must not call this (throws).
	 */
	sendSnapshot(seq: number, page: KbPage): Promise<void>;
	subscribe(handler: (frame: CollabFrame) => void): () => void;
	close(): void;
}

/**
 * Monitor adapter only (C6). Replicas may call `submitPage`.
 * Not on `CollabSession` — do not put persist on `sendSnapshot`.
 */
export interface MonitorCollabAdapter extends CollabSession {
	readonly kind: 'monitor';
	readonly role: 'replica';
	/** POST /v1/collab/snapshot. Acked-prefix page only. */
	submitPage(seq: number, page: KbPage): Promise<void>;
}

export const REPLICA_SEND_SNAPSHOT_ERROR = 'sendSnapshot is sequencer→replicas only';

/**
 * `hello.schemaVersion` is each sender's max understood, not the file version.
 * Compatible iff both capabilities are >= the snapshot page's schemaVersion.
 */
export function schemaCompatible(
	localCapability: number,
	remoteCapability: number,
	snapshotSchemaVersion: number
): boolean {
	return localCapability >= snapshotSchemaVersion && remoteCapability >= snapshotSchemaVersion;
}

/**
 * v1 nack/409 recovery: wait until localSeq >= headSeq, then replace from a
 * snapshot whose seq >= headSeq. Ops that skip past headSeq must not block
 * replace. Never transformOp, never invert-local.
 */
export function shouldReplaceFromSnapshot(
	localSeq: number,
	nackHeadSeq: number,
	snapshotSeq: number
): boolean {
	return localSeq >= nackHeadSeq && snapshotSeq >= nackHeadSeq;
}

function subtreeIds(block: Block, into: string[] = []): string[] {
	into.push(block.id);
	const kids = blockChildren(block);
	if (kids) for (const child of kids) subtreeIds(child, into);
	return into;
}

/** Block ids a remote op mutated (split touches keep + newId; delete-block includes descendants). */
export function blockIdsTouchedByOp(page: KbPage, op: Op): Set<string> {
	switch (op.kind) {
		case 'set-title':
		case 'set-children':
			return new Set();
		case 'insert-text':
			return new Set([op.at.blockId]);
		case 'delete-range':
		case 'format-range': {
			const ids = new Set([op.range.anchor.blockId, op.range.head.blockId]);
			const order = documentOrder(page);
			const ai = order.findIndex((block) => block.id === op.range.anchor.blockId);
			const hi = order.findIndex((block) => block.id === op.range.head.blockId);
			if (ai >= 0 && hi >= 0) {
				const lo = Math.min(ai, hi);
				const hi2 = Math.max(ai, hi);
				for (let i = lo; i <= hi2; i++) ids.add(order[i].id);
			}
			return ids;
		}
		case 'split-block':
			return new Set([op.at.blockId, op.newId]);
		case 'merge-block':
			return new Set([op.keepId, op.dropId]);
		case 'insert-block':
			return new Set(subtreeIds(op.block));
		case 'delete-block': {
			const block = findBlock(page, op.id);
			return new Set(block ? subtreeIds(block) : [op.id]);
		}
		case 'move-block':
			return new Set([op.id]);
		case 'convert-block':
		case 'set-code':
		case 'set-toggle':
		case 'set-align':
		case 'set-valign':
		case 'set-line-height':
		case 'set-space-after':
		case 'set-indent':
			return new Set([op.id]);
		case 'insert-table-row':
			return new Set([op.tableId, ...subtreeIds(op.row)]);
		case 'insert-table-column':
			return new Set([op.tableId, ...op.cells.map((c) => c.id)]);
		case 'delete-table-row':
		case 'delete-table-column':
			return new Set([op.tableId]);
		default: {
			const _never: never = op;
			void _never;
			return new Set();
		}
	}
}

/** Ids named by a stored undo op (page may already have changed). */
export function opNamesBlockIds(op: Op): string[] {
	switch (op.kind) {
		case 'set-title':
		case 'set-children':
			return [];
		case 'insert-text':
			return [op.at.blockId];
		case 'delete-range':
		case 'format-range':
			return [op.range.anchor.blockId, op.range.head.blockId];
		case 'split-block':
			return [op.at.blockId, op.newId];
		case 'merge-block':
			return [op.keepId, op.dropId];
		case 'insert-block':
			return subtreeIds(op.block);
		case 'delete-block':
			return [op.id];
		case 'move-block':
			return [op.id];
		case 'convert-block':
		case 'set-code':
		case 'set-toggle':
		case 'set-align':
		case 'set-valign':
		case 'set-line-height':
		case 'set-space-after':
		case 'set-indent':
			return [op.id];
		case 'insert-table-row':
			return [op.tableId, ...subtreeIds(op.row)];
		case 'insert-table-column':
			return [op.tableId, ...op.cells.map((c) => c.id)];
		case 'delete-table-row':
		case 'delete-table-column':
			return [op.tableId];
		default: {
			const _never: never = op;
			void _never;
			return [];
		}
	}
}

/**
 * v1 does not promise same-block undo after remotes: stored inverses are stale
 * without transformOp, so drop those groups. Editor wiring is C5.
 */
export function dropUndoGroupsTouchedByRemote(groups: Op[][], page: KbPage, remote: Op): Op[][] {
	const touched = blockIdsTouchedByOp(page, remote);
	if (touched.size === 0) return groups;
	return groups.filter((group) => !group.some((op) => opNamesBlockIds(op).some((id) => touched.has(id))));
}

function emit(handlers: Set<(frame: CollabFrame) => void>, frame: CollabFrame): void {
	for (const handler of handlers) handler(frame);
}

/**
 * Asset-channel payload helpers. Pure and dependency-free so the runtime and
 * its tests can share one framing. 64 KiB pre-encode: well under every
 * datachannel's message ceiling, and a 5 MiB asset caps at 80 frames.
 */
const ASSET_CHUNK_BYTES = 64 * 1024;

/** FNV-1a 32-bit, hex — a change detector, not a integrity boundary. */
export function assetHash(bytes: Uint8Array): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) {
		hash ^= bytes[i]!;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

function bytesToBase64(bytes: Uint8Array): string {
	let out = '';
	const step = 0x8000;
	for (let i = 0; i < bytes.length; i += step) {
		out += String.fromCharCode(...bytes.subarray(i, i + step));
	}
	if (typeof btoa === 'function') return btoa(out);
	return Buffer.from(out, 'binary').toString('base64');
}

function base64ToBytes(text: string): Uint8Array {
	if (typeof atob === 'function') {
		const binary = atob(text);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
		return out;
	}
	return Uint8Array.from(Buffer.from(text, 'base64'));
}

/** Split asset bytes into ordered base64 chunks for `asset` frames. */
export function chunkAsset(bytes: Uint8Array, chunkBytes = ASSET_CHUNK_BYTES): string[] {
	const chunks: string[] = [];
	for (let i = 0; i < bytes.length; i += chunkBytes) {
		chunks.push(bytesToBase64(bytes.subarray(i, i + chunkBytes)));
	}
	if (chunks.length === 0) chunks.push('');
	return chunks;
}

/** Reassemble ordered `asset` frame chunks back into bytes. */
export function reassembleAsset(chunks: string[]): Uint8Array {
	const parts = chunks.map(base64ToBytes);
	const total = parts.reduce((n, part) => n + part.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/**
 * `asset` frame factory: chunks bytes and stamps the fingerprint once.
 * Empty assets are legal and carry one empty chunk.
 */
export function assetFrames(
	src: string,
	bytes: Uint8Array,
	envelope: { pageId: string; clientId: string; roomId?: string }
): { hash: string; frames: Extract<CollabFrame, { kind: 'asset' }>[] } {
	const hash = assetHash(bytes);
	const chunks = chunkAsset(bytes);
	return {
		hash,
		frames: chunks.map((chunk, index) => ({
			kind: 'asset',
			...envelope,
			src,
			hash,
			index,
			total: chunks.length,
			chunk
		}))
	};
}

/** Loopback session for engine tests. Adapters (CM / monitor) construct the real thing. */
export function createLoopbackCollabSession(opts: CollabSessionOpts): CollabSession {
	const handlers = new Set<(frame: CollabFrame) => void>();
	let closed = false;

	const session: CollabSession = {
		kind: opts.kind,
		role: opts.role,
		pageId: opts.pageId,
		clientId: opts.clientId,
		schemaVersion: opts.schemaVersion,
		ready: Promise.resolve(),
		sendFrame(frame) {
			if (closed) return;
			emit(handlers, frame);
		},
		async sendOps(ops, clientOpId, baseSeq) {
			if (closed) return;
			emit(handlers, {
				kind: 'ops',
				pageId: opts.pageId,
				clientId: opts.clientId,
				clientOpId,
				baseSeq,
				seq: baseSeq + 1,
				ops
			});
		},
		sendPresence(state) {
			if (closed) return;
			emit(handlers, { kind: 'presence', clientId: opts.clientId, state });
		},
		async sendSnapshot(seq, page) {
			if (session.role === 'replica') {
				throw new Error(REPLICA_SEND_SNAPSHOT_ERROR);
			}
			if (closed) return;
			emit(handlers, { kind: 'snapshot', pageId: opts.pageId, seq, page });
		},
		subscribe(handler) {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		close() {
			closed = true;
			handlers.clear();
		}
	};
	return session;
}
