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
	let sawMissing = false;
	let emittedLive = false;
	let lastKey = '';
	let nodeWatchActive = false;
	let unsubNode: () => void = () => {};

	const emit = (snap: LiveLinkSnapshot) => {
		if (closed) return;
		const key = `${snap.state}:${snap.node?.generation ?? ''}:${snap.node?.blobId ?? ''}:${snap.node?.deletedAt ?? ''}`;
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

	const identityMismatch = (node: VfsNode): boolean => {
		const blobMismatch = bindBlobId !== undefined && node.blobId !== bindBlobId;
		const genMismatch = bindGeneration !== undefined && node.generation !== bindGeneration;
		if (bindBlobId !== undefined) return blobMismatch;
		return genMismatch;
	};

	const refresh = async () => {
		if (closed) return;
		let node: VfsNode | undefined;
		try {
			node = await vfs.get(id);
		} catch {
			node = undefined;
		}
		if (closed) return;

		if (!node) {
			sawMissing = true;
			stopNodeWatch();
			emit({ state: 'missing', node: undefined });
			return;
		}

		if (!bindFromOpts) {
			if (bindGeneration === undefined) bindGeneration = node.generation;
			if (bindBlobId === undefined && node.blobId !== undefined) bindBlobId = node.blobId;
		}

		const recycled = identityMismatch(node) && (sawMissing || bindFromOpts) && (!emittedLive || sawMissing);
		if (recycled) {
			stopNodeWatch();
			emit({ state: 'replaced', node });
			return;
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
		unsubBus();
		stopNodeWatch();
	};
}
