/**
 * Location-independent open-file session. Identity is VfsNode.id; generation
 * is content CAS only. Watchers diff parent/name/path/deletedAt/generation
 * independently so a coalesced move+content tick emits both events.
 */
import type {
	DocumentEvent,
	DocumentSnapshot,
	OpenDocument,
	UpdateFileOpts,
	VfsNode,
	WriteFileInput
} from './types.js';
import { VfsError } from './types.js';

export type DocumentHost = {
	get(id: string): Promise<VfsNode | undefined>;
	getPath(id: string): Promise<VfsNode[]>;
	subscribe(listener: () => void): () => void;
	updateFile(id: string, body: unknown, opts: UpdateFileOpts): Promise<VfsNode>;
	writeFile(input: WriteFileInput): Promise<VfsNode>;
	liveSnapshot?(id: string): { subscribe: (obs: { next: (s: DocumentSnapshot) => void }) => { unsubscribe: () => void } };
};

function pathSignature(path: VfsNode[]): string {
	return path.map((n) => `${n.id}:${n.name}`).join('/');
}

export function diffDocumentSnapshots(
	prev: DocumentSnapshot,
	next: DocumentSnapshot
): DocumentEvent[] {
	const events: DocumentEvent[] = [];
	const nextNode = next.node;
	if (!nextNode || nextNode.deletedAt != null) {
		events.push({
			type: 'deleted',
			reason: nextNode && nextNode.deletedAt != null ? 'trash' : 'permanent'
		});
		return events;
	}
	const prevNode = prev.node;
	if (!prevNode || prevNode.deletedAt != null) return events;

	const pathChanged =
		prevNode.parentId !== nextNode.parentId ||
		prevNode.name !== nextNode.name ||
		pathSignature(prev.path) !== pathSignature(next.path);
	if (pathChanged) {
		events.push({
			type: 'path',
			parentId: nextNode.parentId,
			name: nextNode.name,
			path: next.path
		});
	}
	if (prevNode.generation !== nextNode.generation) {
		events.push({
			type: 'content',
			generation: nextNode.generation,
			conflict: false
		});
	}
	return events;
}

async function loadSnapshot(host: DocumentHost, id: string): Promise<DocumentSnapshot> {
	const node = await host.get(id);
	const path = node ? await host.getPath(id) : [];
	return { node, path };
}

function snapshotKey(s: DocumentSnapshot): string {
	const n = s.node;
	if (!n) return 'missing';
	return [
		n.id,
		n.parentId ?? '',
		n.name,
		n.deletedAt ?? '',
		n.generation,
		pathSignature(s.path)
	].join('|');
}

export function watchNode(
	host: DocumentHost,
	id: string,
	listener: (event: DocumentEvent) => void,
	initial?: DocumentSnapshot
): () => void {
	let prev: DocumentSnapshot | null = initial ?? null;
	let closed = false;
	let lastKey = initial ? snapshotKey(initial) : '';

	const emitDiff = (next: DocumentSnapshot) => {
		if (closed) return;
		const key = snapshotKey(next);
		if (key === lastKey) return;
		lastKey = key;
		if (!prev) {
			prev = next;
			return;
		}
		const events = diffDocumentSnapshots(prev, next);
		prev = next;
		for (const event of events) {
			listener(event);
			if (event.type === 'deleted') {
				close();
				return;
			}
		}
	};

	const poll = () => {
		void loadSnapshot(host, id).then(emitDiff);
	};

	const unsubBus = host.subscribe(poll);
	let unsubLive: (() => void) | undefined;
	if (host.liveSnapshot) {
		const sub = host.liveSnapshot(id).subscribe({ next: emitDiff });
		unsubLive = () => sub.unsubscribe();
	}
	poll();

	function close() {
		if (closed) return;
		closed = true;
		unsubBus();
		unsubLive?.();
	}
	return close;
}

export async function createOpenDocument(
	host: DocumentHost,
	id: string,
	opts?: { generation?: number }
): Promise<OpenDocument> {
	const initial = await host.get(id);
	if (!initial) throw new VfsError('NOT_FOUND', id);
	if (initial.kind !== 'file') throw new VfsError('NOT_A_FILE', id);
	if (initial.deletedAt != null) throw new VfsError('TRASH_STATE', id);

	let node = initial;
	let path = await host.getPath(id);
	let generation = opts?.generation ?? initial.generation;
	let dirty = false;
	let bound = true;
	let gone: 'trash' | 'permanent' | null = null;
	const listeners = new Set<(event: DocumentEvent) => void>();

	const emit = (event: DocumentEvent) => {
		for (const fn of [...listeners]) {
			try {
				fn(event);
			} catch {
				/* a stale editor must not break others */
			}
		}
	};

	let unsubWatch: () => void = () => {};
	unsubWatch = watchNode(
		host,
		id,
		(event) => {
		if (!bound) return;
		if (event.type === 'path') {
			node = { ...node, parentId: event.parentId, name: event.name };
			path = event.path;
			void host.get(id).then((fresh) => {
				if (fresh && bound) node = { ...fresh, generation: node.generation };
			});
			emit(event);
			return;
		}
		if (event.type === 'content') {
			if (event.generation === generation && !dirty) {
				void host.get(id).then((fresh) => {
					if (fresh && bound) node = fresh;
				});
				return;
			}
			if (dirty) {
				emit({ type: 'content', generation: event.generation, conflict: true });
				return;
			}
			generation = event.generation;
			void host.get(id).then((fresh) => {
				if (fresh && bound) node = fresh;
			});
			emit(event);
			return;
		}
		gone = event.reason;
		bound = false;
		unsubWatch();
		emit(event);
		},
		{ node: initial, path }
	);

	const session: OpenDocument = {
		get id() {
			return id;
		},
		get bound() {
			return bound;
		},
		get dirty() {
			return dirty;
		},
		get generation() {
			return generation;
		},
		get node() {
			return node;
		},
		get path() {
			return path;
		},
		markDirty() {
			if (bound) dirty = true;
		},
		async save(body, opts) {
			if (!bound) {
				throw new VfsError(gone === 'trash' ? 'TRASH_STATE' : 'NOT_FOUND', id);
			}
			const meta = opts?.meta;
			const cas: UpdateFileOpts = opts?.force
				? meta !== undefined
					? { force: true, meta }
					: { force: true }
				: meta !== undefined
					? { expectedGeneration: generation, meta }
					: { expectedGeneration: generation };
			const result = await host.updateFile(id, body, cas);
			generation = result.generation;
			node = result;
			dirty = false;
			return result;
		},
		async saveAs(input) {
			const { id: _ignored, ...rest } = input as WriteFileInput;
			void _ignored;
			return host.writeFile(rest);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		close() {
			if (!bound && listeners.size === 0) return;
			bound = false;
			unsubWatch();
			listeners.clear();
		}
	};
	return session;
}
