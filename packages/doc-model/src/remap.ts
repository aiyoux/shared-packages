/**
 * Rewrite block ids across a document and its ops.
 *
 * A file backend never needs this: it mints ids client-side and they are
 * final. A record backend cannot — the server assigns the id, but the editor
 * needs one the instant a block exists, because the caret, the undo stack and
 * every op refer to blocks by id. So the client mints `temp:<uuid>`, uses it
 * everywhere, and rewrites it when the real id arrives. That rewrite is what
 * this module does.
 *
 * Always a **map**, never a `(from, to)` pair: one create batch returns many
 * ids at once — inserting a table mints thirteen (table + 3 rows + 9 cells) —
 * and they must be rewritten together or an intermediate state escapes.
 *
 * ## Why this is not `opNamesBlockIds`
 *
 * `collab.ts` already walks every op for block ids, exhaustively and with a
 * `never` guard. It is the wrong walker: it returns the ids an op **touches**,
 * which is what collab wants, not the ids an op **references**. `move-block`
 * names only `id` — never `afterId` or `parentId`; `insert-block` names its
 * subtree but not where it goes. Those are block ids too, and a remap that
 * misses them leaves a `temp:` id pointing at nothing once the real ids land.
 *
 * So this is a sibling walker with the same shape and the same exhaustiveness
 * guard, covering positional references as well as touched blocks.
 *
 * `set-children` is deliberately untouched: its `children` are child-page
 * slugs in the KB envelope, not block ids. Rewriting them would corrupt the
 * page tree.
 */
import type { Block, KbPage, Op, Point, Range, TableCellBlock, TableRowBlock } from './types.js';

export type IdMap = ReadonlyMap<string, string>;

const to = (map: IdMap, id: string): string => map.get(id) ?? id;

function remapNullable(map: IdMap, id: string | null | undefined): string | null | undefined {
	if (id === null || id === undefined) return id;
	return to(map, id);
}

function remapPoint(map: IdMap, point: Point): Point {
	const blockId = to(map, point.blockId);
	return blockId === point.blockId ? point : { ...point, blockId };
}

function remapRange(map: IdMap, range: Range): Range {
	return { anchor: remapPoint(map, range.anchor), head: remapPoint(map, range.head) };
}

/** Rewrite a block and everything beneath it (callout / toggle / table children). */
export function remapBlockIds<T extends Block>(map: IdMap, block: T): T {
	const kids = (block as Block & { children?: unknown }).children;
	const next: Block = { ...block, id: to(map, block.id) };
	if (Array.isArray(kids)) {
		(next as Block & { children: Block[] }).children = (kids as Block[]).map((child) =>
			remapBlockIds(map, child)
		);
	}
	return next as T;
}

/**
 * Rewrite every block id an op names — both the blocks it acts on and the
 * blocks it positions against.
 */
export function remapOpIds(map: IdMap, op: Op): Op {
	if (map.size === 0) return op;
	switch (op.kind) {
		case 'set-title':
		// `children` here are page slugs, not block ids.
		case 'set-children':
			return op;
		case 'insert-text':
			return { ...op, at: remapPoint(map, op.at) };
		case 'delete-range':
		case 'format-range':
			return { ...op, range: remapRange(map, op.range) };
		case 'split-block':
			return { ...op, at: remapPoint(map, op.at), newId: to(map, op.newId) };
		case 'merge-block':
			return { ...op, keepId: to(map, op.keepId), dropId: to(map, op.dropId) };
		case 'insert-block':
			return {
				...op,
				afterId: remapNullable(map, op.afterId) as string | null,
				parentId: remapNullable(map, op.parentId),
				block: remapBlockIds(map, op.block)
			};
		case 'delete-block':
		case 'convert-block':
		case 'set-code':
		case 'set-toggle':
			return { ...op, id: to(map, op.id) };
		case 'move-block':
			return {
				...op,
				id: to(map, op.id),
				afterId: remapNullable(map, op.afterId) as string | null,
				parentId: remapNullable(map, op.parentId)
			};
		case 'insert-table-row':
			return {
				...op,
				tableId: to(map, op.tableId),
				afterId: remapNullable(map, op.afterId) as string | null,
				row: remapBlockIds(map, op.row) as TableRowBlock
			};
		case 'insert-table-column':
			return {
				...op,
				tableId: to(map, op.tableId),
				cells: op.cells.map((cell) => remapBlockIds(map, cell) as TableCellBlock)
			};
		case 'delete-table-row':
			return { ...op, tableId: to(map, op.tableId), rowId: to(map, op.rowId) };
		case 'delete-table-column':
			return { ...op, tableId: to(map, op.tableId) };
		default: {
			const _never: never = op;
			void _never;
			return op;
		}
	}
}

export function remapOps(map: IdMap, ops: readonly Op[]): Op[] {
	if (map.size === 0) return [...ops];
	return ops.map((op) => remapOpIds(map, op));
}

/**
 * Rewrite a whole page: its own id and every block id in the tree.
 *
 * The page id is included because a record backend assigns that too — a page
 * is created in the same batch as its first block, so both arrive as `temp:`
 * ids and both are remapped together.
 */
export function remapPageIds(map: IdMap, page: KbPage): KbPage {
	if (map.size === 0) return page;
	return {
		...page,
		id: to(map, page.id),
		blocks: page.blocks.map((block) => remapBlockIds(map, block))
	};
}
