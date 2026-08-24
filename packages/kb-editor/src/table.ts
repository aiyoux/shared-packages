import {
	findBlock,
	isTableStructure,
	parentOf,
	plaintextOf,
	type KbPage,
	type Op,
	type Point,
	type Range,
	type TableBlock,
	type TableCellBlock,
	type TableRowBlock
} from '@shared-packages/kb-model';
import { newBlockId } from './ids.js';
import { collapsed, deleteRangeOps, isCollapsed, orderedRange } from './range.js';

export const DEFAULT_TABLE_COLS = 3;
export const DEFAULT_TABLE_ROWS = 2;

function emptySpans(): TableCellBlock['content'] {
	return [{ type: 'text', text: '', marks: [] }];
}

export function emptyCell(id = newBlockId(), header = false): TableCellBlock {
	return header
		? { id, type: 'table_cell', header: true, content: emptySpans() }
		: { id, type: 'table_cell', content: emptySpans() };
}

export function emptyTableRow(width: number, id = newBlockId()): TableRowBlock {
	const cells: TableCellBlock[] = [];
	for (let i = 0; i < Math.max(1, width); i++) cells.push(emptyCell());
	return { id, type: 'table_row', children: cells };
}

export function defaultTable(rows = DEFAULT_TABLE_ROWS, cols = DEFAULT_TABLE_COLS): TableBlock {
	const children: TableRowBlock[] = [];
	for (let r = 0; r < Math.max(1, rows); r++) children.push(emptyTableRow(cols));
	return { id: newBlockId(), type: 'table', children };
}

export type CellCoords = {
	table: TableBlock;
	row: TableRowBlock;
	cell: TableCellBlock;
	rowIndex: number;
	colIndex: number;
};

export function cellCoords(page: KbPage, cellId: string): CellCoords | null {
	const cell = findBlock(page, cellId);
	if (!cell || cell.type !== 'table_cell') return null;
	const rowLoc = parentOf(page, cellId);
	if (!rowLoc || rowLoc.parent === 'page' || rowLoc.parent.type !== 'table_row') return null;
	const row = rowLoc.parent;
	const tableLoc = parentOf(page, row.id);
	if (!tableLoc || tableLoc.parent === 'page' || tableLoc.parent.type !== 'table') return null;
	return {
		table: tableLoc.parent,
		row,
		cell,
		rowIndex: tableLoc.index,
		colIndex: rowLoc.index
	};
}

export function enclosingTable(page: KbPage, id: string): TableBlock | null {
	const block = findBlock(page, id);
	if (!block) return null;
	if (block.type === 'table') return block;
	if (block.type === 'table_row') {
		const loc = parentOf(page, id);
		if (loc && loc.parent !== 'page' && loc.parent.type === 'table') return loc.parent;
		return null;
	}
	return cellCoords(page, id)?.table ?? null;
}

/** Page-root afterId for typing/pasting on table or row chrome. */
export function afterTableId(page: KbPage, blockId: string): string | null {
	const block = findBlock(page, blockId);
	if (!block) return null;
	if (block.type === 'table') return block.id;
	const table = enclosingTable(page, blockId);
	return table?.id ?? blockId;
}

export function isTableChrome(page: KbPage, blockId: string): boolean {
	const block = findBlock(page, blockId);
	return !!block && isTableStructure(block);
}

function widthOf(table: TableBlock): number {
	return table.children[0]?.children.length ?? 0;
}

export type TableNav = { ops: Op[]; selection: Range };

export function tabOps(page: KbPage, live: Range, shift: boolean): TableNav | null {
	const { start } = orderedRange(page, live);
	const coords = cellCoords(page, start.blockId);
	if (!coords) return null;
	const { table, rowIndex, colIndex } = coords;
	const width = widthOf(table);
	const height = table.children.length;
	if (shift) {
		if (colIndex > 0) {
			const cell = table.children[rowIndex].children[colIndex - 1];
			return { ops: [], selection: collapsed({ blockId: cell.id, offset: plaintextOf(cell).length }) };
		}
		if (rowIndex > 0) {
			const prev = table.children[rowIndex - 1];
			const cell = prev.children[prev.children.length - 1];
			return { ops: [], selection: collapsed({ blockId: cell.id, offset: plaintextOf(cell).length }) };
		}
		return { ops: [], selection: collapsed({ blockId: coords.cell.id, offset: 0 }) };
	}
	if (colIndex < width - 1) {
		const cell = table.children[rowIndex].children[colIndex + 1];
		return { ops: [], selection: collapsed({ blockId: cell.id, offset: 0 }) };
	}
	if (rowIndex < height - 1) {
		const cell = table.children[rowIndex + 1].children[0];
		return { ops: [], selection: collapsed({ blockId: cell.id, offset: 0 }) };
	}
	const row = emptyTableRow(width);
	return {
		ops: [{ kind: 'insert-table-row', tableId: table.id, afterId: table.children[height - 1]!.id, row }],
		selection: collapsed({ blockId: row.children[0]!.id, offset: 0 })
	};
}

export function enterCellOps(page: KbPage, live: Range): TableNav | null {
	const { start } = orderedRange(page, live);
	const coords = cellCoords(page, start.blockId);
	if (!coords) return null;
	const prefix = isCollapsed(live) ? [] : deleteRangeOps(page, live);
	const { table, rowIndex, colIndex } = coords;
	const height = table.children.length;
	const width = widthOf(table);
	if (rowIndex < height - 1) {
		const cell = table.children[rowIndex + 1].children[colIndex];
		return { ops: prefix, selection: collapsed({ blockId: cell.id, offset: 0 }) };
	}
	const row = emptyTableRow(width);
	const dest = row.children[Math.min(colIndex, row.children.length - 1)]!;
	return {
		ops: [
			...prefix,
			{ kind: 'insert-table-row', tableId: table.id, afterId: table.children[height - 1]!.id, row }
		],
		selection: collapsed({ blockId: dest.id, offset: 0 })
	};
}

export function deleteRowOps(page: KbPage, rowId: string): Op[] {
	const table = enclosingTable(page, rowId);
	if (!table) return [];
	if (table.children.length <= 1) return [{ kind: 'delete-block', id: table.id }];
	return [{ kind: 'delete-table-row', tableId: table.id, rowId }];
}

function sliceCellContent(cell: TableCellBlock, from: number, to: number): TableCellBlock {
	const text = plaintextOf(cell);
	const a = Math.max(0, Math.min(from, text.length));
	const b = Math.max(a, Math.min(to, text.length));
	const sliced = text.slice(a, b);
	const content = sliced
		? [{ type: 'text' as const, text: sliced, marks: [] }]
		: emptySpans();
	return cell.header
		? { id: cell.id, type: 'table_cell', header: true, content }
		: { id: cell.id, type: 'table_cell', content };
}

export type TableRect = {
	table: TableBlock;
	r0: number;
	r1: number;
	c0: number;
	c1: number;
};

export function tableRect(page: KbPage, range: Range): TableRect | null {
	if (isCollapsed(range)) return null;
	const { start, end } = orderedRange(page, range);
	const a = cellCoords(page, start.blockId);
	const b = cellCoords(page, end.blockId);
	if (!a || !b || a.table.id !== b.table.id) return null;
	return {
		table: a.table,
		r0: Math.min(a.rowIndex, b.rowIndex),
		r1: Math.max(a.rowIndex, b.rowIndex),
		c0: Math.min(a.colIndex, b.colIndex),
		c1: Math.max(a.colIndex, b.colIndex)
	};
}

/** Bounding-rectangle table slice. Same-cell ranges return null (plain text-like slice). */
export function sliceTableRect(page: KbPage, range: Range): TableBlock | null {
	const rect = tableRect(page, range);
	if (!rect) return null;
	if (rect.r0 === rect.r1 && rect.c0 === rect.c1) return null;
	const { start, end } = orderedRange(page, range);
	const rows: TableRowBlock[] = [];
	for (let r = rect.r0; r <= rect.r1; r++) {
		const src = rect.table.children[r]!;
		const cells: TableCellBlock[] = [];
		for (let c = rect.c0; c <= rect.c1; c++) {
			const cell = src.children[c]!;
			let from = 0;
			let to = plaintextOf(cell).length;
			if (cell.id === start.blockId) from = start.offset;
			if (cell.id === end.blockId) to = end.offset;
			cells.push(sliceCellContent(cell, from, to));
		}
		rows.push({ id: src.id, type: 'table_row', children: cells });
	}
	return { id: rect.table.id, type: 'table', children: rows };
}

export function cellPlaintext(text: string): string {
	return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, ' ');
}

export function parseTsv(text: string): string[][] | null {
	const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	if (!normalized.includes('\t') && !normalized.includes('\n')) return null;
	const rows = normalized.split('\n');
	if (rows.length === 1 && !rows[0]!.includes('\t')) return null;
	return rows.map((row) => row.split('\t'));
}

function rowsFromTable(table: TableBlock): string[][] {
	return table.children.map((row) => row.children.map((cell) => plaintextOf(cell)));
}

export function pasteCellsIntoTable(page: KbPage, at: Point, rows: string[][]): Op[] {
	const coords = cellCoords(page, at.blockId);
	if (!coords || rows.length === 0) return [];
	const ops: Op[] = [];
	const { table, rowIndex, colIndex } = coords;
	const width = widthOf(table);
	const height = table.children.length;
	let afterId = table.children[height - 1]!.id;
	const created: TableRowBlock[] = [];
	const needed = rowIndex + rows.length - height;
	for (let i = 0; i < needed; i++) {
		const row = emptyTableRow(width);
		ops.push({ kind: 'insert-table-row', tableId: table.id, afterId, row });
		created.push(row);
		afterId = row.id;
	}
	function destCell(r: number, c: number): TableCellBlock | null {
		if (c >= width || c < 0) return null;
		if (r < height) return table.children[r]!.children[c] ?? null;
		return created[r - height]?.children[c] ?? null;
	}
	for (let dr = 0; dr < rows.length; dr++) {
		const line = rows[dr]!;
		for (let dc = 0; dc < line.length; dc++) {
			const cell = destCell(rowIndex + dr, colIndex + dc);
			if (!cell) continue;
			const text = cellPlaintext(line[dc] ?? '');
			if (dr === 0 && dc === 0) {
				if (text) ops.push({ kind: 'insert-text', at, text });
				continue;
			}
			const len = plaintextOf(cell).length;
			if (len > 0) {
				ops.push({
					kind: 'delete-range',
					range: {
						anchor: { blockId: cell.id, offset: 0 },
						head: { blockId: cell.id, offset: len }
					}
				});
			}
			if (text) ops.push({ kind: 'insert-text', at: { blockId: cell.id, offset: 0 }, text });
		}
	}
	return ops;
}

export function pasteTableAtCell(page: KbPage, at: Point, table: TableBlock): Op[] {
	return pasteCellsIntoTable(page, at, rowsFromTable(table));
}
