import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apply } from './apply.js';
import { applyRemote } from './applyRemote.js';
import { dropUndoGroupsTouchedByRemote, schemaCompatible } from './collab.js';
import { createEmptyPage } from './createEmptyPage.js';
import { mapPointThroughOp, snapMappedPoint, type StickyPoint } from './mapPoint.js';
import { normalizePage } from './normalize.js';
import { plaintext, plaintextOf } from './plaintext.js';
import { KB_FORMAT, type Block, type KbPage, type Op, type TextSpan } from './types.js';

const STAMP = '2026-01-01T00:00:00.000Z';
const goldenPath = join(dirname(fileURLToPath(import.meta.url)), 'goldens/map-point.json');
const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as {
	splitBlock205: {
		blockId: string;
		newId: string;
		text: string;
		splitAt: number;
		caretBefore: StickyPoint;
		caretAfter: StickyPoint;
	};
};

function span(text: string): TextSpan {
	return { type: 'text', text, marks: [] };
}

function para(id: string, text: string): Block {
	return { id, type: 'paragraph', content: [span(text)] };
}

function page(blocks: Block[], schemaVersion = 1): KbPage {
	return normalizePage({
		format: KB_FORMAT,
		schemaVersion,
		id: 'page-1',
		title: 'Title',
		createdAt: STAMP,
		updatedAt: STAMP,
		children: [],
		blocks
	});
}

describe('C7a model goldens', () => {
	it('1. two carets: A splits above B, B stays in the new block (#205)', () => {
		const g = golden.splitBlock205;
		const src = page([para(g.blockId, g.text)]);
		const op: Op = { kind: 'split-block', at: { blockId: g.blockId, offset: g.splitAt }, newId: g.newId };
		expect(mapPointThroughOp(src, g.caretBefore, op)).toEqual(g.caretAfter);
		const next = apply(src, op);
		expect(plaintextOf(next.blocks[0])).toBe(g.text.slice(0, g.splitAt));
		expect(next.blocks[1].id).toBe(g.newId);
		expect(plaintextOf(next.blocks[1])).toBe(g.text.slice(g.splitAt));
	});

	it('2. sibling remote insert does not mutate the composing block', () => {
		const src = page([para('p', 'hi'), para('q', 'yy')]);
		const next = applyRemote(src, { kind: 'insert-text', at: { blockId: 'p', offset: 0 }, text: 'X' });
		expect(plaintextOf(next.blocks[0])).toBe('Xhi');
		expect(plaintextOf(next.blocks[1])).toBe('yy');
	});

	it("3. A deletes B's block, B snaps, no throw", () => {
		const src = page([para('a', 'aa'), para('b', 'bb'), para('c', 'cc')]);
		const point: StickyPoint = { blockId: 'b', offset: 1 };
		expect(mapPointThroughOp(src, point, { kind: 'delete-block', id: 'b' })).toBeNull();
		expect(() => applyRemote(src, { kind: 'delete-block', id: 'b' })).not.toThrow();
		const after = applyRemote(src, { kind: 'delete-block', id: 'b' });
		expect(after.blocks.map((b) => b.id)).toEqual(['a', 'c']);
		expect(snapMappedPoint(src, after, point)).toEqual({ blockId: 'c', offset: 0 });
	});

	it('4. Cmd-Z on A does not revert B (other-block undo groups survive)', () => {
		const src = page([para('x', 'aa'), para('y', 'bb')]);
		const undo: Op[][] = [
			[{ kind: 'insert-text', at: { blockId: 'x', offset: 0 }, text: 'Z' }],
			[{ kind: 'insert-text', at: { blockId: 'y', offset: 0 }, text: 'Q' }]
		];
		const remote: Op = { kind: 'insert-text', at: { blockId: 'y', offset: 0 }, text: 'B' };
		expect(dropUndoGroupsTouchedByRemote(undo, src, remote)).toEqual([undo[0]]);
	});

	it('4b. same-block undo group is dropped (no-op, does not revert B)', () => {
		const src = page([para('x', 'aa'), para('y', 'bb')]);
		const undo: Op[][] = [[{ kind: 'insert-text', at: { blockId: 'x', offset: 0 }, text: 'Z' }]];
		const remote: Op = { kind: 'insert-text', at: { blockId: 'x', offset: 1 }, text: 'R' };
		expect(dropUndoGroupsTouchedByRemote(undo, src, remote)).toEqual([]);
	});

	it('5. Join: remote non-empty snapshot is the page; local seed id is not in it', () => {
		const seed = createEmptyPage({ id: 'page-1', title: 'seed' });
		const remote = page([para('host-p', 'from-sequencer')]);
		expect(plaintext(remote)).toBe('from-sequencer');
		expect(remote.blocks.map((b) => b.id)).toEqual(['host-p']);
		expect(remote.blocks[0]!.id).not.toBe(seed.blocks[0]!.id);
	});

	it('6. two v2 clients on a v1 file write; v1 client + v2 snapshot is read-only', () => {
		expect(schemaCompatible(2, 2, 1)).toBe(true);
		expect(schemaCompatible(1, 2, 2)).toBe(false);
		expect(schemaCompatible(2, 1, 2)).toBe(false);
		expect(page([para('p', 'x')], 1).schemaVersion).toBe(1);
	});
});
