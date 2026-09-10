import { describe, it, expect } from 'vitest';
import {
	ALL_BLOCK_KINDS,
	canInsert,
	FULL_CAPABILITIES,
	RECORD_BACKEND_BLOCK_KINDS,
	unsupportedKindsIn
} from './capabilities.js';
import type { Block } from './types.js';

const span = (text: string) => [{ type: 'text' as const, text, marks: [] }];
const para = (id: string): Block => ({ id, type: 'paragraph', content: span('x') });

const recordCaps = { blocks: RECORD_BACKEND_BLOCK_KINDS };

/**
 * A backend that has caught up — as the record one now has — cannot exercise
 * the gate. So the mechanism is tested against a deliberately partial set, and
 * the record backend's own coverage is asserted separately.
 */
const limitedCaps = { blocks: ['paragraph', 'heading', 'image'] } as const;

describe('capabilities', () => {
	it('lets the file backend insert everything the AST can express', () => {
		for (const kind of ALL_BLOCK_KINDS) {
			expect(canInsert(FULL_CAPABILITIES, kind)).toBe(true);
		}
	});

	/**
	 * The whole point: a backend with no schema variant for a type must not be
	 * offered it, or a user creates a block the write silently drops.
	 */
	it('stops a backend offering blocks it cannot store', () => {
		expect(canInsert(limitedCaps, 'callout')).toBe(false);
		expect(canInsert(limitedCaps, 'toggle')).toBe(false);
		expect(canInsert(limitedCaps, 'table')).toBe(false);
		expect(canInsert(limitedCaps, 'paragraph')).toBe(true);
		expect(canInsert(limitedCaps, 'image')).toBe(true);
	});

	/**
	 * The record backend nests blocks on `graph_child_of` block → block edges
	 * now, and has a schema variant for every type, so it declares all of them.
	 */
	it('lets the record backend insert everything it declares', () => {
		for (const kind of RECORD_BACKEND_BLOCK_KINDS) {
			expect(canInsert(recordCaps, kind), kind).toBe(true);
		}
		expect(canInsert(recordCaps, 'page_break')).toBe(false);
	});

	it('treats an absent capability set as unrestricted', () => {
		expect(canInsert(undefined, 'table')).toBe(true);
	});

	it('reports unsupported kinds nested inside containers', () => {
		const blocks: Block[] = [
			para('p1'),
			{
				id: 'c1',
				type: 'callout',
				variant: 'info',
				children: [
					para('p2'),
					{ id: 't1', type: 'table', children: [] }
				]
			}
		];
		expect(unsupportedKindsIn(blocks, limitedCaps).sort()).toEqual(['callout', 'table']);
	});

	it('reports table once, not once per row and cell', () => {
		const blocks: Block[] = [
			{
				id: 't1',
				type: 'table',
				children: [
					{
						id: 'r1',
						type: 'table_row',
						children: [{ id: 'c1', type: 'table_cell', content: span('a') }]
					}
				]
			}
		];
		expect(unsupportedKindsIn(blocks, limitedCaps)).toEqual(['table']);
	});

	it('reports nothing when everything fits', () => {
		expect(unsupportedKindsIn([para('p1')], recordCaps)).toEqual([]);
	});

	/**
	 * Reading is always allowed. A document written by the file backend must
	 * still load on the record backend — it just cannot create more of them.
	 */
	it('reports rather than throws, so a richer document can still be read', () => {
		const blocks: Block[] = [{ id: 't1', type: 'table', children: [] }];
		expect(() => unsupportedKindsIn(blocks, limitedCaps)).not.toThrow();
	});
});
