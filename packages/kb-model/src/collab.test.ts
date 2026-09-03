import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	REPLICA_SEND_SNAPSHOT_ERROR,
	blockIdsTouchedByOp,
	createLoopbackCollabSession,
	dropUndoGroupsTouchedByRemote,
	schemaCompatible,
	shouldReplaceFromSnapshot,
	type CollabFrame,
	type CollabSession,
	type MonitorCollabAdapter
} from './collab.js';
import { createEmptyPage } from './createEmptyPage.js';
import { normalizePage } from './normalize.js';
import { KB_FORMAT, type Block, type KbPage, type Op, type TextSpan } from './types.js';

const STAMP = '2026-01-01T00:00:00.000Z';

function span(text: string): TextSpan {
	return { type: 'text', text, marks: [] };
}

function para(id: string, text: string): Block {
	return { id, type: 'paragraph', content: [span(text)] };
}

function page(blocks: Block[]): KbPage {
	return normalizePage({
		format: KB_FORMAT,
		id: 'page-1',
		title: 'Title',
		createdAt: STAMP,
		updatedAt: STAMP,
		children: [],
		blocks
	});
}

describe('CollabSession', () => {
	it('sendSnapshot throws on a replica', async () => {
		const replica = createLoopbackCollabSession({
			kind: 'cm',
			role: 'replica',
			pageId: 'page-1',
			schemaVersion: 1,
			clientId: 'guest'
		});
		await expect(replica.sendSnapshot(1, createEmptyPage({ id: 'page-1', title: 'T' }))).rejects.toThrow(
			REPLICA_SEND_SNAPSHOT_ERROR
		);
	});

	it('sendSnapshot is sequencer→replicas only and does not persist', async () => {
		const seq = createLoopbackCollabSession({
			kind: 'cm',
			role: 'sequencer',
			pageId: 'page-1',
			schemaVersion: 1,
			clientId: 'host'
		});
		const seen: CollabFrame[] = [];
		const stop = seq.subscribe((frame) => seen.push(frame));
		const doc = createEmptyPage({ id: 'page-1', title: 'T' });
		await seq.sendSnapshot(3, doc);
		expect(seen).toEqual([{ kind: 'snapshot', pageId: 'page-1', seq: 3, page: doc }]);
		stop();
		expectTypeOf<CollabSession>().not.toHaveProperty('submitPage');
		expectTypeOf<MonitorCollabAdapter>().toHaveProperty('submitPage');
		expectTypeOf<MonitorCollabAdapter['kind']>().toEqualTypeOf<'monitor'>();
		expectTypeOf<MonitorCollabAdapter['role']>().toEqualTypeOf<'replica'>();
	});

	it('hello.schemaVersion is capability: compatible iff both >= snapshot file version', () => {
		expect(schemaCompatible(2, 2, 1)).toBe(true);
		expect(schemaCompatible(2, 2, 2)).toBe(true);
		expect(schemaCompatible(1, 2, 2)).toBe(false);
		expect(schemaCompatible(2, 1, 2)).toBe(false);
		expect(schemaCompatible(1, 1, 1)).toBe(true);
	});

	it('nack recovery is replace-from-snapshot after wait-for-seq, not transformOp', () => {
		expect(shouldReplaceFromSnapshot(5, 5, 5)).toBe(true);
		expect(shouldReplaceFromSnapshot(5, 5, 6)).toBe(true);
		expect(shouldReplaceFromSnapshot(4, 5, 5)).toBe(false);
		expect(shouldReplaceFromSnapshot(5, 5, 4)).toBe(false);
		expect(shouldReplaceFromSnapshot(6, 5, 5)).toBe(true);
	});

	it('drops same-block undo groups after a remote (C5 wires this; no invert-and-hope)', () => {
		const src = page([para('x', 'aa'), para('y', 'bb')]);
		const undo: Op[][] = [
			[{ kind: 'insert-text', at: { blockId: 'x', offset: 0 }, text: 'Z' }],
			[{ kind: 'insert-text', at: { blockId: 'y', offset: 0 }, text: 'Q' }]
		];
		const remote: Op = { kind: 'insert-text', at: { blockId: 'x', offset: 1 }, text: 'R' };
		expect(dropUndoGroupsTouchedByRemote(undo, src, remote)).toEqual([undo[1]]);
		const split: Op = { kind: 'split-block', at: { blockId: 'y', offset: 1 }, newId: 'n' };
		expect(dropUndoGroupsTouchedByRemote(undo, src, split)).toEqual([undo[0]]);
		expect(blockIdsTouchedByOp(src, split)).toEqual(new Set(['y', 'n']));
	});
});
