import type { VfsNode } from './types.js';
import type { VfsService } from './vfs.js';

export type LiveLinkState = 'live' | 'trashed' | 'missing' | 'replaced';

export type LiveLinkSnapshot = {
	state: LiveLinkState;
	node: VfsNode | undefined;
};

export type ObserveLiveLinkOpts = {
	/** Identity captured at bind. Recycled ids after hard-delete become `replaced`. */
	generation?: number;
	blobId?: string;
	createdAt?: number;
};

/**
 * Watch a VFS node id for live-link identity (trash / restore / recycle).
 *
 * Does not follow `vfs.copy` (new id). `openDocument` / `subscribeNode` emit
 * `deleted` and unsubscribe, so restore is not an event there — this helper
 * uses the change bus (`subscribe`) plus `get(id)` so trash and restore of
 * the same id are visible. Snapshot mode: content (generation) changes stay
 * `live`; the app decides when to refresh bytes.
 */
export function observeLiveLink(
	vfs: Pick<VfsService, 'get' | 'subscribe' | 'subscribeNode'>,
	id: string,
	onChange: (s: LiveLinkSnapshot) => void,
	opts?: ObserveLiveLinkOpts
): () => void {
	let closed = false;
	const bindFromOpts = opts?.generation !== undefined || opts?.blobId !== undefined;
	let bindGeneration = opts?.generation;
	let bindBlobId = opts?.blobId;
	let bindCreatedAt = opts?.createdAt;
	let sawMissing = false;
	let emittedLive = false;
	let lastKey = '';
	let epoch = 0;
	let nodeWatchActive = false;
	let unsubNode: () => void = () => {};

	const emit = (snap: LiveLinkSnapshot) => {
		if (closed) return;
		const key = `${snap.state}:${snap.node?.generation ?? ''}:${snap.node?.blobId ?? ''}:${snap.node?.deletedAt ?? ''}:${snap.node?.createdAt ?? ''}`;
		if (key === lastKey) return;
		lastKey = key;
		if (snap.state === 'live') emittedLive = true;
		onChange(snap);
	};

	const stopNodeWatch = () => {
		if (!nodeWatchActive) return;
		nodeWatchActive = false;
		unsubNode();
		unsubNode = () => {};
	};

	const startNodeWatch = () => {
		if (closed || nodeWatchActive) return;
		nodeWatchActive = true;
		unsubNode = vfs.subscribeNode(id, (event) => {
			if (event.type === 'deleted') stopNodeWatch();
			void refresh();
		});
	};

	const isReplaced = (node: VfsNode): boolean => {
		const blobMismatch = bindBlobId !== undefined && node.blobId !== bindBlobId;
		const createdMismatch = bindCreatedAt !== undefined && node.createdAt !== bindCreatedAt;
		const genDropped =
			emittedLive &&
			bindGeneration !== undefined &&
			bindGeneration > 1 &&
			node.generation === 1 &&
			blobMismatch;
		if (createdMismatch) return true;
		if (genDropped) return true;
		if (sawMissing && blobMismatch) return true;
		if (!emittedLive && bindFromOpts && blobMismatch) return true;
		return false;
	};

	const refresh = async () => {
		const my = ++epoch;
		if (closed) return;
		let node: VfsNode | undefined;
		try {
			node = await vfs.get(id);
		} catch {
			node = undefined;
		}
		if (closed || my !== epoch) return;

		if (!node) {
			sawMissing = true;
			stopNodeWatch();
			emit({ state: 'missing', node: undefined });
			return;
		}

		if (isReplaced(node)) {
			stopNodeWatch();
			emit({ state: 'replaced', node });
			return;
		}

		if (bindCreatedAt === undefined) bindCreatedAt = node.createdAt;
		if (!bindFromOpts) {
			if (bindGeneration === undefined) bindGeneration = node.generation;
			if (bindBlobId === undefined && node.blobId !== undefined) bindBlobId = node.blobId;
		}

		if (node.deletedAt != null) {
			stopNodeWatch();
			emit({ state: 'trashed', node });
			return;
		}

		startNodeWatch();
		emit({ state: 'live', node });
	};

	const unsubBus = vfs.subscribe(() => {
		void refresh();
	});
	void refresh();

	return () => {
		if (closed) return;
		closed = true;
		epoch += 1;
		unsubBus();
		stopNodeWatch();
	};
}
