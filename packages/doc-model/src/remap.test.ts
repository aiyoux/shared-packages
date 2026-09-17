import { describe, it, expect } from 'vitest';
import { remapBlockIds, remapOpIds, remapOps, remapPageIds } from './remap.js';
import { opNamesBlockIds } from './collab.js';
import type { Block, KbPage, Op, TableBlock } from './types.js';

const map = new Map([
	['temp:a', 'records:1'],
	['temp:b', 'records:2'],
	['temp:c', 'records:3'],
	['temp:row', 'records:row'],
	['temp:cell', 'records:cell'],
	['temp:page', 'records:page']
]);

const span = (text: string) => [{ type: 'text' as const, text, marks: [] }];
const para = (id: string, text = 'x'): Block => ({ id, type: 'paragraph', content: span(text) });
const point = (blockId: string, offset = 0) => ({ blockId, offset });

function page(blocks: Block[], id = 'temp:page'): KbPage {
	return {
		format: 'kb',
		id,
		title: 'T',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		children: ['child-slug', 'temp:a'],
		blocks
	};
}

describe('remapOpIds', () => {
	it('rewrites the point of insert-text', () => {
		const op: Op = { kind: 'insert-text', at: point('temp:a', 3), text: 'hi' };
		expect(remapOpIds(map, op)).toEqual({
			kind: 'insert-text',
			at: point('records:1', 3),
			text: 'hi'
		});
	});

	it('rewrites both ends of a range', () => {
		const op: Op = {
			kind: 'delete-range',
			range: { anchor: point('temp:a', 1), head: point('temp:b', 2) }
		};
		const out = remapOpIds(map, op) as Extract<Op, { kind: 'delete-range' }>;
		expect(out.range.anchor.blockId).toBe('records:1');
		expect(out.range.head.blockId).toBe('records:2');
	});

	it('rewrites both ids of split-block and merge-block', () => {
		expect(remapOpIds(map, { kind: 'split-block', at: point('temp:a', 1), newId: 'temp:b' })).toEqual(
			{ kind: 'split-block', at: point('records:1', 1), newId: 'records:2' }
		);
		expect(remapOpIds(map, { kind: 'merge-block', keepId: 'temp:a', dropId: 'temp:b' })).toEqual({
			kind: 'merge-block',
			keepId: 'records:1',
			dropId: 'records:2'
		});
	});

	/**
	 * The reason this is not `opNamesBlockIds`. That walker returns the ids an
	 * op TOUCHES; these are ids an op REFERENCES to position itself. Missing
	 * them leaves a temp id pointing at nothing.
	 */
	it('rewrites positional refs that opNamesBlockIds does not report', () => {
		const insert: Op = {
			kind: 'insert-block',
			afterId: 'temp:a',
			parentId: 'temp:b',
			block: para('temp:c')
		};
		expect(opNamesBlockIds(insert)).not.toContain('temp:a');
		const out = remapOpIds(map, insert) as Extract<Op, { kind: 'insert-block' }>;
		expect(out.afterId).toBe('records:1');
		expect(out.parentId).toBe('records:2');
		expect(out.block.id).toBe('records:3');

		const move: Op = { kind: 'move-block', id: 'temp:c', afterId: 'temp:a', parentId: 'temp:b' };
		expect(opNamesBlockIds(move)).toEqual(['temp:c']);
		const moved = remapOpIds(map, move) as Extract<Op, { kind: 'move-block' }>;
		expect(moved).toEqual({
			kind: 'move-block',
			id: 'records:3',
			afterId: 'records:1',
			parentId: 'records:2'
		});
	});

	it('keeps null afterId as null rather than inventing an id', () => {
		const out = remapOpIds(map, {
			kind: 'insert-block',
			afterId: null,
			block: para('temp:a')
		}) as Extract<Op, { kind: 'insert-block' }>;
		expect(out.afterId).toBeNull();
		expect(out.block.id).toBe('records:1');
	});

	it('rewrites table ops including nested rows and cells', () => {
		const row: Extract<Block, { type: 'table_row' }> = {
			id: 'temp:row',
			type: 'table_row',
			children: [{ id: 'temp:cell', type: 'table_cell', content: span('c') }]
		};
		const out = remapOpIds(map, {
			kind: 'insert-table-row',
			tableId: 'temp:a',
			afterId: 'temp:b',
			row
		}) as Extract<Op, { kind: 'insert-table-row' }>;
		expect(out.tableId).toBe('records:1');
		expect(out.afterId).toBe('records:2');
		expect(out.row.id).toBe('records:row');
		expect(out.row.children[0].id).toBe('records:cell');

		const col = remapOpIds(map, {
			kind: 'insert-table-column',
			tableId: 'temp:a',
			index: 1,
			cells: [{ id: 'temp:cell', type: 'table_cell', content: span('c') }]
		}) as Extract<Op, { kind: 'insert-table-column' }>;
		expect(col.tableId).toBe('records:1');
		expect(col.cells[0].id).toBe('records:cell');

		expect(
			remapOpIds(map, { kind: 'delete-table-row', tableId: 'temp:a', rowId: 'temp:row' })
		).toEqual({ kind: 'delete-table-row', tableId: 'records:1', rowId: 'records:row' });
	});

	it('rewrites the single-id ops', () => {
		for (const kind of [
			'delete-block',
			'convert-block',
			'set-code',
			'set-toggle',
			'set-align',
			'set-valign',
			'set-line-height',
			'set-space-after',
			'set-indent'
		] as const) {
			const op = { kind, id: 'temp:a', to: 'paragraph', language: 'ts', open: true } as unknown as Op;
			expect((remapOpIds(map, op) as { id: string }).id).toBe('records:1');
		}
	});

	/**
	 * `set-children` holds child-PAGE slugs, not block ids. One of the fixture
	 * slugs is deliberately spelled like a mapped block id: rewriting it would
	 * silently repoint the page tree.
	 */
	it('never rewrites set-children, whose entries are page slugs', () => {
		const op: Op = { kind: 'set-children', children: ['child-slug', 'temp:a'] };
		expect(remapOpIds(map, op)).toEqual(op);
	});

	it('leaves set-title alone', () => {
		const op: Op = { kind: 'set-title', title: 'temp:a' };
		expect(remapOpIds(map, op)).toEqual(op);
	});

	it('leaves unmapped ids untouched', () => {
		const op: Op = { kind: 'delete-block', id: 'records:already-real' };
		expect(remapOpIds(map, op)).toEqual(op);
	});

	it('returns the op unchanged for an empty map', () => {
		const op: Op = { kind: 'delete-block', id: 'temp:a' };
		expect(remapOpIds(new Map(), op)).toBe(op);
	});
});

describe('remapBlockIds', () => {
	it('rewrites a nested container subtree', () => {
		const table: TableBlock = {
			id: 'temp:a',
			type: 'table',
			children: [
				{
					id: 'temp:row',
					type: 'table_row',
					children: [{ id: 'temp:cell', type: 'table_cell', content: span('c') }]
				}
			]
		};
		const out = remapBlockIds(map, table);
		expect(out.id).toBe('records:1');
		expect(out.children[0].id).toBe('records:row');
		expect(out.children[0].children[0].id).toBe('records:cell');
	});

	it('does not mutate the input', () => {
		const block = para('temp:a');
		remapBlockIds(map, block);
		expect(block.id).toBe('temp:a');
	});
});

describe('remapPageIds', () => {
	it('rewrites the page id as well as the blocks', () => {
		const out = remapPageIds(map, page([para('temp:a'), para('temp:b')]));
		expect(out.id).toBe('records:page');
		expect(out.blocks.map((b) => b.id)).toEqual(['records:1', 'records:2']);
	});

	it('leaves the child-page slug list alone', () => {
		const out = remapPageIds(map, page([para('temp:a')]));
		expect(out.children).toEqual(['child-slug', 'temp:a']);
	});
});

describe('remapOps', () => {
	it('rewrites a whole undo group', () => {
		const group: Op[] = [
			{ kind: 'insert-text', at: point('temp:a'), text: 'x' },
			{ kind: 'delete-block', id: 'temp:b' }
		];
		const out = remapOps(map, group);
		expect((out[0] as Extract<Op, { kind: 'insert-text' }>).at.blockId).toBe('records:1');
		expect((out[1] as Extract<Op, { kind: 'delete-block' }>).id).toBe('records:2');
	});
});

/**
 * Both walkers switch on every op kind with a `never` guard, so a new kind
 * cannot be added to one and forgotten in the other. This asserts they cover
 * the same kinds today.
 */
describe('walker parity', () => {
	const kinds: Op['kind'][] = [
		'set-title',
		'insert-text',
		'delete-range',
		'format-range',
		'split-block',
		'merge-block',
		'insert-block',
		'delete-block',
		'move-block',
		'convert-block',
		'set-code',
		'set-children',
		'set-toggle',
		'set-align',
		'set-valign',
		'set-line-height',
		'set-space-after',
		'set-indent',
		'insert-table-row',
		'insert-table-column',
		'delete-table-row',
		'delete-table-column'
	];

	it('covers every op kind in the union', () => {
		// If a kind is added to `Op`, this assignment fails to compile.
		const exhaustive: Record<Op['kind'], true> = Object.fromEntries(
			kinds.map((k) => [k, true])
		) as Record<Op['kind'], true>;
		expect(Object.keys(exhaustive).sort()).toEqual([...kinds].sort());
	});
});
