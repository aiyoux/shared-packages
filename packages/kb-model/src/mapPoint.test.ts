import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apply } from './apply.js';
import { applyRemoteBatch } from './applyRemote.js';
import {
	mapPointThroughOp,
	mapRangeThroughOp,
	snapMappedPoint,
	type Assoc,
	type StickyPoint
} from './mapPoint.js';
import { normalizePage } from './normalize.js';
import { plaintextOf } from './plaintext.js';
import { KB_FORMAT, type Block, type KbPage, type Mark, type Op, type TextSpan } from './types.js';

const STAMP = '2026-01-01T00:00:00.000Z';
const goldenPath = join(dirname(fileURLToPath(import.meta.url)), 'goldens/map-point.json');
const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as {
	insertText: {
		text: string;
		insert: { at: number; text: string };
		cases: { offset: number; after: number; assoc?: Assoc; otherBlock?: boolean }[];
	};
	deleteRange: {
		text: string;
		range: { from: number; to: number };
		cases: { offset: number; after: number }[];
	};
	splitBlock205: {
		blockId: string;
		newId: string;
		text: string;
		splitAt: number;
		caretBefore: StickyPoint;
		caretAfter: StickyPoint;
	};
	deleteBlock: {
		blocks: string[];
		deleteId: string;
		caretBlock: string;
		snapTo: StickyPoint;
	};
	applyRemoteBatch: {
		text: string;
		point: StickyPoint;
		ops: Op[];
		after: StickyPoint;
	};
};

function span(text: string, marks: Mark[] = []): TextSpan {
	return { type: 'text', text, marks };
}

function para(id: string, text: string): Block {
	return { id, type: 'paragraph', content: [span(text)] };
}

function page(blocks: Block[]): KbPage {
	return normalizePage({
		format: KB_FORMAT,
		schemaVersion: 1,
		id: 'page-1',
		title: 'Title',
		createdAt: STAMP,
		updatedAt: STAMP,
		children: [],
		blocks
	});
}

describe('mapPointThroughOp goldens', () => {
	it('maps insert-text with assoc (default -1 does not shift at the insert point)', () => {
		const src = page([para('A', golden.insertText.text), para('Z', 'zz')]);
		const op: Op = {
			kind: 'insert-text',
			at: { blockId: 'A', offset: golden.insertText.insert.at },
			text: golden.insertText.insert.text
		};
		for (const row of golden.insertText.cases) {
			const point: StickyPoint = row.otherBlock
				? { blockId: 'Z', offset: row.offset }
				: row.assoc === undefined
					? { blockId: 'A', offset: row.offset }
					: { blockId: 'A', offset: row.offset, assoc: row.assoc };
			const mapped = mapPointThroughOp(src, point, op);
			expect(mapped, JSON.stringify(row)).toEqual({
				...point,
				offset: row.after
			});
		}
	});

	it('maps delete-range in one block (in-span snaps to start; after shifts)', () => {
		const src = page([para('A', golden.deleteRange.text)]);
		const op: Op = {
			kind: 'delete-range',
			range: {
				anchor: { blockId: 'A', offset: golden.deleteRange.range.from },
				head: { blockId: 'A', offset: golden.deleteRange.range.to }
			}
		};
		for (const row of golden.deleteRange.cases) {
			const mapped = mapPointThroughOp(src, { blockId: 'A', offset: row.offset }, op);
			expect(mapped?.offset, `offset ${row.offset}`).toBe(row.after);
			expect(mapped?.blockId).toBe('A');
		}
	});

	it('split-block #205: after a remote split above B, B stays in the new block', () => {
		const g = golden.splitBlock205;
		const src = page([para(g.blockId, g.text)]);
		const op: Op = { kind: 'split-block', at: { blockId: g.blockId, offset: g.splitAt }, newId: g.newId };
		const mapped = mapPointThroughOp(src, g.caretBefore, op);
		expect(mapped).toEqual(g.caretAfter);
		const next = apply(src, op);
		expect(plaintextOf(next.blocks[0])).toBe(g.text.slice(0, g.splitAt));
		expect(next.blocks[1].id).toBe(g.newId);
		expect(plaintextOf(next.blocks[1])).toBe(g.text.slice(g.splitAt));
	});

	it('delete-block: caret maps to null then snaps to the following text-like', () => {
		const g = golden.deleteBlock;
		const src = page(g.blocks.map((text, i) => para(['a', 'b', 'c'][i], text)));
		const op: Op = { kind: 'delete-block', id: g.deleteId };
		const point: StickyPoint = { blockId: g.caretBlock, offset: 1 };
		expect(mapPointThroughOp(src, point, op)).toBeNull();
		const after = apply(src, op);
		expect(snapMappedPoint(src, after, point)).toEqual(g.snapTo);
	});
});

describe('mapPointThroughOp v1 op table', () => {
	it('maps cross-block delete-range leftovers onto the start id when concat applies', () => {
		const src = page([para('a', 'hello'), para('b', 'world')]);
		const op: Op = {
			kind: 'delete-range',
			range: { anchor: { blockId: 'a', offset: 3 }, head: { blockId: 'b', offset: 2 } }
		};
		expect(mapPointThroughOp(src, { blockId: 'b', offset: 4 }, op)).toEqual({ blockId: 'a', offset: 5 });
		expect(mapPointThroughOp(src, { blockId: 'a', offset: 5 }, op)).toEqual({ blockId: 'a', offset: 3 });
		expect(mapPointThroughOp(src, { blockId: 'a', offset: 1 }, op)).toEqual({ blockId: 'a', offset: 1 });
		const mid = page([para('a', 'aa'), para('m', 'xx'), para('c', 'cc')]);
		const dropMid: Op = {
			kind: 'delete-range',
			range: { anchor: { blockId: 'a', offset: 1 }, head: { blockId: 'c', offset: 1 } }
		};
		expect(mapPointThroughOp(mid, { blockId: 'm', offset: 1 }, dropMid)).toBeNull();
	});

	it('split-block assoc: < 1 stays on old; 1 follows newId', () => {
		const src = page([para('A', 'abcdefghij')]);
		const op: Op = { kind: 'split-block', at: { blockId: 'A', offset: 4 }, newId: 'N' };
		expect(mapPointThroughOp(src, { blockId: 'A', offset: 4 }, op)).toEqual({ blockId: 'A', offset: 4 });
		expect(mapPointThroughOp(src, { blockId: 'A', offset: 4, assoc: 0 }, op)).toEqual({
			blockId: 'A',
			offset: 4,
			assoc: 0
		});
		expect(mapPointThroughOp(src, { blockId: 'A', offset: 4, assoc: 1 }, op)).toEqual({
			blockId: 'N',
			offset: 0,
			assoc: 1
		});
		expect(mapPointThroughOp(src, { blockId: 'Z', offset: 1 }, op)).toEqual({ blockId: 'Z', offset: 1 });
	});

	it('merge-block remaps dropId using pre-page keepLen', () => {
		const src = page([para('k', 'he'), para('d', 'llo')]);
		const op: Op = { kind: 'merge-block', keepId: 'k', dropId: 'd' };
		expect(mapPointThroughOp(src, { blockId: 'd', offset: 2 }, op)).toEqual({ blockId: 'k', offset: 4 });
		expect(mapPointThroughOp(src, { blockId: 'k', offset: 1 }, op)).toEqual({ blockId: 'k', offset: 1 });
		expect(mapPointThroughOp(src, { blockId: 'z', offset: 0 }, op)).toEqual({ blockId: 'z', offset: 0 });
	});

	it('insert-block / move-block / format-range / set-title / set-children leave points', () => {
		const src = page([para('a', 'aa'), para('b', 'bb')]);
		const point: StickyPoint = { blockId: 'b', offset: 1 };
		expect(
			mapPointThroughOp(src, point, { kind: 'insert-block', afterId: 'a', block: para('n', 'n') })
		).toEqual(point);
		expect(mapPointThroughOp(src, point, { kind: 'move-block', id: 'b', afterId: null })).toEqual(point);
		expect(
			mapPointThroughOp(src, point, {
				kind: 'format-range',
				range: { anchor: { blockId: 'a', offset: 0 }, head: { blockId: 'a', offset: 2 } },
				mark: { type: 'bold' },
				on: true
			})
		).toEqual(point);
		expect(mapPointThroughOp(src, point, { kind: 'set-title', title: 'X' })).toEqual(point);
		expect(mapPointThroughOp(src, point, { kind: 'set-children', children: ['x'] })).toEqual(point);
	});

	it('convert-block clamps offset to the new payload length', () => {
		const src = page([para('p', 'Hello')]);
		const toDivider: Op = { kind: 'convert-block', id: 'p', to: 'divider' };
		expect(mapPointThroughOp(src, { blockId: 'p', offset: 4 }, toDivider)).toEqual({
			blockId: 'p',
			offset: 0
		});
		expect(mapPointThroughOp(src, { blockId: 'p', offset: 4 }, { kind: 'convert-block', id: 'p', to: 'heading' })).toEqual({
			blockId: 'p',
			offset: 4
		});
		expect(
			mapPointThroughOp(src, { blockId: 'p', offset: 1 }, { kind: 'convert-block', id: 'p', to: 'image' })
		).toEqual({ blockId: 'p', offset: 1 });
	});

	it('set-code clamps to the code text length', () => {
		const src = page([{ id: 'c', type: 'code', language: 'js', text: 'ab' }]);
		expect(mapPointThroughOp(src, { blockId: 'c', offset: 9 }, { kind: 'set-code', id: 'c', language: 'ts' })).toEqual({
			blockId: 'c',
			offset: 2
		});
		expect(mapPointThroughOp(src, { blockId: 'z', offset: 1 }, { kind: 'set-code', id: 'c', language: 'ts' })).toEqual({
			blockId: 'z',
			offset: 1
		});
	});

	it('delete-block of the last block snaps onto the remaining empty paragraph', () => {
		const src = page([para('only', 'x')]);
		const point: StickyPoint = { blockId: 'only', offset: 0 };
		expect(mapPointThroughOp(src, point, { kind: 'delete-block', id: 'only' })).toBeNull();
		const after = apply(src, { kind: 'delete-block', id: 'only' });
		const snapped = snapMappedPoint(src, after, point);
		expect(snapped.blockId).not.toBe('only');
		expect(snapped.offset).toBe(0);
		expect(after.blocks).toHaveLength(1);
	});

	it('delete-block at the end snaps to the previous text-like end', () => {
		const src = page([para('a', 'aa'), para('b', 'bb')]);
		const point: StickyPoint = { blockId: 'b', offset: 1 };
		expect(mapPointThroughOp(src, point, { kind: 'delete-block', id: 'b' })).toBeNull();
		const after = apply(src, { kind: 'delete-block', id: 'b' });
		expect(snapMappedPoint(src, after, point)).toEqual({ blockId: 'a', offset: 2 });
	});

	it('mapRangeThroughOp maps both ends or returns null if either is deleted', () => {
		const src = page([para('a', 'hello'), para('b', 'world')]);
		const insert: Op = { kind: 'insert-text', at: { blockId: 'a', offset: 1 }, text: 'X' };
		expect(
			mapRangeThroughOp(
				src,
				{ anchor: { blockId: 'a', offset: 0 }, head: { blockId: 'a', offset: 5 } },
				insert
			)
		).toEqual({
			anchor: { blockId: 'a', offset: 0 },
			head: { blockId: 'a', offset: 6 }
		});
		expect(
			mapRangeThroughOp(
				src,
				{ anchor: { blockId: 'a', offset: 1 }, head: { blockId: 'b', offset: 1 } },
				{ kind: 'delete-block', id: 'b' }
			)
		).toBeNull();
	});

	it('does not throw when mapping an unresolved remote op', () => {
		const src = page([para('a', 'aa')]);
		expect(
			mapPointThroughOp(src, { blockId: 'a', offset: 1 }, {
				kind: 'insert-text',
				at: { blockId: 'missing', offset: 0 },
				text: 'x'
			})
		).toEqual({ blockId: 'a', offset: 1 });
		expect(
			mapPointThroughOp(src, { blockId: 'a', offset: 1 }, {
				kind: 'delete-range',
				range: { anchor: { blockId: 'missing', offset: 0 }, head: { blockId: 'a', offset: 1 } }
			})
		).toEqual({ blockId: 'a', offset: 1 });
	});
});

describe('applyRemoteBatch golden', () => {
	it('maps each op against the page before that op, not a stale tree', () => {
		const g = golden.applyRemoteBatch;
		const src = page([para('A', g.text)]);
		const staleSplit = mapPointThroughOp(src, g.point, g.ops[1]);
		expect(staleSplit).not.toEqual(g.after);
		const { page: next, point } = applyRemoteBatch(src, g.ops, g.point);
		expect(point).toEqual(g.after);
		expect(next.blocks.map((b) => b.id)).toEqual(['A', 'N']);
		expect(plaintextOf(next.blocks[0])).toBe('helloX');
		expect(plaintextOf(next.blocks[1])).toBe(' world');
	});
});
