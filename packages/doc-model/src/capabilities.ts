/**
 * Which block types a backend can actually store.
 *
 * The two backends need not agree. A file page holds one JSON tree, so it can
 * store anything the AST can express. A record backend needs a schema variant
 * per block type, and a nesting story for the types that hold children.
 *
 * Without a gate, mounting the shared toolbar on the record backend offers the
 * user a table it cannot persist. That is not a missing feature, it is silent
 * data loss: the block appears, the editor is happy, and the write drops it.
 *
 * So the host declares what it supports and the UI hides the rest. The gate is
 * on the **host**, not on `apply` — the AST stays whole, because a document
 * read from a richer backend must still be representable in memory even where
 * it cannot be created.
 */
import type { Block } from './types.js';

export type BlockKind = Block['type'];

/**
 * Everything the AST can express. The file backend supports all of it.
 *
 * Structural table parts (`table_row`, `table_cell`) are not listed
 * separately: they exist only inside a `table`, so `table` gates all three.
 */
export const ALL_BLOCK_KINDS = [
	'paragraph',
	'heading',
	'list_item',
	'code',
	'divider',
	'image',
	'callout',
	'toggle',
	'table'
] as const;

export type InsertableBlockKind = (typeof ALL_BLOCK_KINDS)[number];

/**
 * What a record backend can store.
 *
 * This is the whole AST again, now that the record adapter nests blocks on
 * `graph_child_of` block → block edges and has schema variants for callout,
 * toggle and the table parts. It stays a separate name rather than an alias
 * of `ALL_BLOCK_KINDS`: the seam is the point, and the next backend will not
 * necessarily arrive complete.
 */
export const RECORD_BACKEND_BLOCK_KINDS: readonly InsertableBlockKind[] = [
	'paragraph',
	'heading',
	'list_item',
	'code',
	'divider',
	'image',
	'callout',
	'toggle',
	'table'
];

export type DocCapabilities = {
	/** Block kinds the host can create and persist. */
	blocks: readonly InsertableBlockKind[];
};

export const FULL_CAPABILITIES: DocCapabilities = { blocks: ALL_BLOCK_KINDS };

export function canInsert(caps: DocCapabilities | undefined, kind: InsertableBlockKind): boolean {
	if (!caps) return true;
	return caps.blocks.includes(kind);
}

/**
 * Block kinds present in a document that the given capabilities cannot store.
 *
 * For diagnostics when a document crosses backends — reading is always
 * allowed, so this reports rather than throws.
 */
export function unsupportedKindsIn(
	blocks: readonly Block[],
	caps: DocCapabilities
): InsertableBlockKind[] {
	const found = new Set<InsertableBlockKind>();
	const walk = (list: readonly Block[]): void => {
		for (const block of list) {
			const kind = block.type;
			if (kind === 'table_row' || kind === 'table_cell') {
				// Reported via their `table` ancestor.
			} else if (!canInsert(caps, kind)) {
				found.add(kind);
			}
			const kids = (block as Block & { children?: unknown }).children;
			if (Array.isArray(kids)) walk(kids as Block[]);
		}
	};
	walk(blocks);
	return [...found];
}
