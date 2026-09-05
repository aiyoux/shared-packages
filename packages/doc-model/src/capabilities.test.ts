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

describe('capabilities', () => {
	it('lets the file backend insert everything the AST can express', () => {
		for (const kind of ALL_BLOCK_KINDS) {
			expect(canInsert(FULL_CAPABILITIES, kind)).toBe(true);
		}
	});

	/**
	 * The whole point: the record backend has no schema variant for these, so
	 * offering them would let a user create a block the write silently drops.
	 */
	it('stops the record backend offering blocks it cannot store', () => {
		expect(canInsert(recordCaps, 'callout')).toBe(false);
		expect(canInsert(recordCaps, 'toggle')).toBe(false);
		expect(canInsert(recordCaps, 'table')).toBe(false);
		expect(canInsert(recordCaps, 'paragraph')).toBe(true);
		expect(canInsert(recordCaps, 'image')).toBe(true);
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
		expect(unsupportedKindsIn(blocks, recordCaps).sort()).toEqual(['callout', 'table']);
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
		expect(unsupportedKindsIn(blocks, recordCaps)).toEqual(['table']);
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
		expect(() => unsupportedKindsIn(blocks, recordCaps)).not.toThrow();
	});
});
