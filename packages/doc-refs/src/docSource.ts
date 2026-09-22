/**
 * One document pointing at another, in the one shape every document type uses.
 *
 * `backend` is the discriminant: read it and you know whether to expect a VFS
 * node id or a monitor profile + path. That is what lets a reference keep
 * resolving wherever its document ends up, and what lets one reader and one
 * writer serve every format.
 *
 * It is deliberately not per-app. `.skch` used to store `vfsNodeId` as a bare
 * string, which could not name a monitor file at all and needed its own
 * extractor and its own rewriter; `docs/design/live-reference-cycles.md`
 * catalogued four such shapes rather than collapsing them. This is the collapse.
 */
export type VfsDocSource = {
	backend: 'shared-vfs';
	nodeId: string;
	generation?: number;
	blobId?: string;
};

export type MonitorDocSource = {
	backend: 'monitor';
	profileId: string;
	ino?: string;
	dev?: string;
	relPath: string;
};

export type DocSource = VfsDocSource | MonitorDocSource;

/**
 * Names one saved view inside a `.data` file. This is not a VFS node id —
 * `nodeId` on a selector would be treated as an unvisited reference.
 * It sits on the source object, the same way a sketch `fragment` does, so a
 * rewrite that stops at the source keeps it.
 */
export type ViewSelector = { kind: 'view'; viewId: string };

/** A `DocSource` that also names a view in that file. */
export type ViewSource = DocSource & { viewId: string };

export function isViewSource(source: DocSource): source is ViewSource {
	const viewId = (source as { viewId?: unknown }).viewId;
	return typeof viewId === 'string' && viewId !== '';
}

export type FsBackend = DocSource['backend'];

/**
 * How a reference is held, from loosest to most pinned.
 *
 * `clone` has no `source` at all — the bytes were copied and nothing is being
 * referenced. The other three do, which is why cycle detection only ever walks
 * `live` and `snapshot` edges.
 */
export const BIND_MODES = ['clone', 'live', 'snapshot', 'gitPin'] as const;

export type BindMode = (typeof BIND_MODES)[number];
