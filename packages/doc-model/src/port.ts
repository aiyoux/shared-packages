/**
 * The seam between a document and where it is stored.
 *
 * One editor, two backends: a file page on a VFS, and a page-plus-block record
 * graph. Everything above this line — AST, ops, undo, editor — is the same for
 * both. Everything below it is not, and this is the list of what "below it"
 * has to provide.
 *
 * Generic over the backend's own node and session types rather than inventing
 * neutral ones. A `VfsNode` and a `records:` row have nothing useful in common
 * to abstract over, and forcing a shared shape would mean each adapter
 * translating into it and straight back out. What must match is the **set of
 * operations**, so that is what this fixes.
 *
 * `DocumentBackend` is deliberately not implemented here. It is the contract
 * an adapter declares it meets, and the compiler checks the claim.
 */
import type { DocCapabilities } from './capabilities.js';
import type { IdMap } from './remap.js';
import type { DocBody } from './types.js';

/** One entry in the page tree, as the sidebar needs it. */
export type DocChildEntry<TNode> = {
	/** The container: a folder on a file backend, a page record on a graph. */
	folder: TNode;
	/** The document itself, or null for a container with no page yet. */
	file: TNode | null;
	title: string;
};

/**
 * What a backend must provide for the shared editor to run on it.
 *
 * @typeParam TNode - the backend's node handle (`VfsNode`, a record row, …)
 * @typeParam TSession - the backend's open-document handle
 * @typeParam TDoc - the document shape, at least a `DocBody`
 */
export interface DocumentBackend<TNode, TSession, TDoc extends DocBody = DocBody> {
	readonly rootId: string;

	/** Read a document without opening an editing session. */
	loadPage(pageId: string): Promise<TDoc>;

	/**
	 * Open an editing session. The session owns the CAS token, so a save can
	 * tell "someone else changed this" from "I changed this".
	 */
	openPage(pageId: string): Promise<TSession>;

	savePage(session: TSession, doc: TDoc): Promise<TNode>;

	createChild(parentId: string, title: string): Promise<{ folder: TNode; file: TNode }>;

	/** `beforeSlug` positions among siblings; a graph backend reads it as order. */
	movePage(pageId: string, newParentId: string, beforeSlug?: string): Promise<void>;

	renameChild(parentId: string, oldName: string, newName: string): Promise<void>;

	/** Fires when the tree changes underneath us — another tab, another peer. */
	watchWorkspace(onChange: () => void): () => void;

	listChildren(parentId: string): Promise<DocChildEntry<TNode>[]>;
}

/**
 * Backends that store images alongside documents.
 *
 * Separate from `DocumentBackend` because a backend can be perfectly useful
 * without it, and the toolbar already hides the image button when the
 * capability is absent.
 */
export interface DocumentAssetBackend<TNode> {
	writePageImage(input: {
		name: string;
		body: Blob | ArrayBuffer | Uint8Array;
	}): Promise<{ src: string; node: TNode }>;
	assetNode(fileName: string): Promise<TNode | null>;
	readAssetBlob(fileName: string): Promise<Blob | null>;
}

/**
 * Backends where the server assigns ids.
 *
 * A file backend mints ids client-side and never implements this. A record
 * backend does: it hands back the `temp:` → real map when a create is
 * accepted, and the host feeds that to `remapIds`. Optional precisely so the
 * file adapter is not made to carry a concept it does not have.
 */
export interface DocumentIdAssigningBackend {
	onIdsAssigned(listener: (map: IdMap) => void): () => void;
}

/** What this backend can store. Drives the toolbar gate. */
export interface DocumentCapabilityBackend {
	readonly capabilities: DocCapabilities;
}
