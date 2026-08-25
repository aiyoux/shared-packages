import { describe, expect, it } from 'vitest';
import { apply, UnresolvedPointError } from './apply.js';
import { applyRemote, applyRemoteBatch, applyRemoteMany, clampPoint } from './applyRemote.js';
import { mapPointThroughOp } from './mapPoint.js';
import { normalizePage } from './normalize.js';
import { plaintextOf } from './plaintext.js';
import { KB_FORMAT, type Block, type KbPage, type Mark, type Op, type TextSpan } from './types.js';

const STAMP = '2026-01-01T00:00:00.000Z';

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

describe('applyRemote', () => {
	it('clamps an out-of-range insert instead of throwing', () => {
		const src = page([para('p', 'hi')]);
		expect(() =>
			apply(src, { kind: 'insert-text', at: { blockId: 'p', offset: 99 }, text: 'X' })
		).toThrow(UnresolvedPointError);
		const next = applyRemote(src, { kind: 'insert-text', at: { blockId: 'p', offset: 99 }, text: 'X' });
		expect(plaintextOf(next.blocks[0])).toBe('hiX');
	});

	it('drops an op whose block is gone instead of throwing the replica off a cliff', () => {
		const src = page([para('p', 'hi')]);
		expect(applyRemote(src, { kind: 'insert-text', at: { blockId: 'missing', offset: 0 }, text: 'X' })).toEqual(
			src
		);
		expect(applyRemote(src, { kind: 'delete-block', id: 'missing' })).toEqual(src);
		expect(
			applyRemote(src, {
				kind: 'delete-range',
				range: { anchor: { blockId: 'missing', offset: 0 }, head: { blockId: 'p', offset: 1 } }
			})
		).toEqual(src);
	});

	it('clamps illegal atomic offsets and drops inserts that still cannot apply', () => {
		const src = page([{ id: 'd', type: 'divider' }, para('p', 'x')]);
		expect(clampPoint(src, { blockId: 'd', offset: 3 })).toEqual({ blockId: 'd', offset: 0 });
		expect(applyRemote(src, { kind: 'insert-text', at: { blockId: 'd', offset: 3 }, text: 'X' })).toEqual(src);
		const split = applyRemote(src, { kind: 'split-block', at: { blockId: 'd', offset: 1 }, newId: 'n' });
		expect(split).toEqual(src);
	});

	it('applyRemoteMany threads clamp-then-apply', () => {
		const src = page([para('p', 'ab')]);
		const next = applyRemoteMany(src, [
			{ kind: 'insert-text', at: { blockId: 'p', offset: 99 }, text: 'X' },
			{ kind: 'insert-text', at: { blockId: 'missing', offset: 0 }, text: 'Y' }
		]);
		expect(plaintextOf(next.blocks[0])).toBe('abX');
	});

	it('applyRemoteBatch maps then applies each op against page-before-that-op', () => {
		const src = page([para('A', 'abcd'), para('B', 'zzzz')]);
		const ops: Op[] = [
			{ kind: 'insert-text', at: { blockId: 'A', offset: 2 }, text: 'XY' },
			{ kind: 'split-block', at: { blockId: 'A', offset: 4 }, newId: 'C' }
		];
		const { page: next, point } = applyRemoteBatch(src, ops, { blockId: 'A', offset: 4 });
		expect(plaintextOf(next.blocks[0])).toBe('abXY');
		expect(next.blocks[1].id).toBe('C');
		expect(plaintextOf(next.blocks[1])).toBe('cd');
		expect(point).toEqual({ blockId: 'C', offset: 2 });
	});

	it('applyRemoteBatch clamps at before mapping so out-of-range insert agrees with applyRemote', () => {
		const src = page([para('p', 'hi')]);
		const op: Op = { kind: 'insert-text', at: { blockId: 'p', offset: 99 }, text: 'X' };
		expect(mapPointThroughOp(src, { blockId: 'p', offset: 2, assoc: 1 }, op)).toEqual({
			blockId: 'p',
			offset: 2,
			assoc: 1
		});
		const { page: next, point } = applyRemoteBatch(src, [op], { blockId: 'p', offset: 2, assoc: 1 });
		expect(plaintextOf(next.blocks[0])).toBe('hiX');
		expect(point).toEqual({ blockId: 'p', offset: 3, assoc: 1 });
	});

	it('applyRemoteBatch does not keep a map when the op is dropped', () => {
		const src = page([para('p', 'ab')]);
		const { page: next, point } = applyRemoteBatch(
			src,
			[{ kind: 'insert-text', at: { blockId: 'p', offset: 1 }, text: '\n' }],
			{ blockId: 'p', offset: 2 }
		);
		expect(next).toEqual(src);
		expect(point).toEqual({ blockId: 'p', offset: 2 });
	});

	it('applyRemoteBatch snaps surrogate-interior at before mapping (a👍b at 2)', () => {
		const src = page([para('p', 'a👍b')]);
		const { page: next, point } = applyRemoteBatch(
			src,
			[{ kind: 'insert-text', at: { blockId: 'p', offset: 2 }, text: 'X' }],
			{ blockId: 'p', offset: 1, assoc: 1 }
		);
		expect(plaintextOf(next.blocks[0])).toBe('aX👍b');
		expect(point).toEqual({ blockId: 'p', offset: 2, assoc: 1 });
	});
});
