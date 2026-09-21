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
