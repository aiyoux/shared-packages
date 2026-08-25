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
	| { kind: 'schema-mismatch'; local: number; remote: number };

/** Wire wrapper so CM dispatch is one `msg.type` branch. */
export type KbCollabMessage = { type: 'kb-collab'; v: 1; frame: CollabFrame };

export type CollabSessionOpts = {
	kind: 'cm' | 'monitor';
	role: CollabRole;
	pageId: string;
	/** This client's max understood (`KB_SCHEMA_VERSION`), not the file version. */
	schemaVersion: number;
	clientId: string;
};

export interface CollabSession {
	readonly kind: 'cm' | 'monitor';
	readonly role: CollabRole;
	readonly pageId: string;
	readonly clientId: string;
	/** This client's max understood (capability). */
	readonly schemaVersion: number;
	readonly ready: Promise<void>;
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
 * v1 nack/409 recovery: wait until localSeq === headSeq, then replace from a
 * snapshot whose seq >= headSeq. Never transformOp, never invert-local.
 */
export function shouldReplaceFromSnapshot(
	localSeq: number,
	nackHeadSeq: number,
	snapshotSeq: number
): boolean {
	return localSeq === nackHeadSeq && snapshotSeq >= nackHeadSeq;
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
			return new Set([op.id]);
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
			return [op.id];
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
