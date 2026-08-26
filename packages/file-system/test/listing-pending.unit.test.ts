import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	mergeListingWithPending,
	pendingLabel,
	pendingOverlay,
	pendingPercent,
	type ListingPending
} from '../src/ui/listingPending.ts';
import type { ExplorerEntry } from '../src/ui/explorerDriver.ts';

function file(name: string, id = name): ExplorerEntry {
	return { id, parentId: null, name, kind: 'file' };
}

function folder(name: string, id = name): ExplorerEntry {
	return { id, parentId: null, name, kind: 'folder' };
}

function pending(p: Partial<ListingPending> & { name: string }): ListingPending {
	return {
		id: p.id ?? `op-${p.name}`,
		name: p.name,
		transferred: p.transferred ?? 0,
		size: p.size ?? 100,
		direction: p.direction,
		ready: p.ready,
		status: p.status,
		done: p.done,
		destParentId: p.destParentId,
		entryKind: p.entryKind
	};
}

describe('listing pending merge', () => {
	it('keeps a placeholder at 50% when the dest has not listed the file', () => {
		const rows = mergeListingWithPending([], [pending({ name: 'clip.wav', transferred: 50 })]);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].placeholder, true);
		assert.equal(rows[0].pending?.name, 'clip.wav');
		assert.equal(pendingLabel(rows[0]!.pending!), '50%');
	});

	it('does not add a second row once the dest file exists', () => {
		const rows = mergeListingWithPending(
			[file('clip.wav')],
			[pending({ name: 'clip.wav', transferred: 40 })]
		);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].placeholder, false);
		assert.equal(rows[0].node.id, 'clip.wav');
		assert.ok(rows[0].pending);
		assert.equal(pendingPercent(rows[0].pending!), 40);
	});

	it('drops the overlay at 100% when the dest file is already listed (solid)', () => {
		const p = pending({ name: 'clip.wav', transferred: 100, size: 100 });
		assert.equal(pendingOverlay(p, true), null);
		const rows = mergeListingWithPending([file('clip.wav')], [p]);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].placeholder, false);
		assert.equal(rows[0].pending, null);
	});

	it('keeps 100% after bytes finish if the dest has not listed the file yet', () => {
		const p = pending({ name: 'clip.wav', transferred: 100, size: 100 });
		assert.equal(pendingLabel(p), '100%');
		const rows = mergeListingWithPending([], [p]);
		assert.equal(rows[0].placeholder, true);
		assert.equal(pendingLabel(rows[0].pending!), '100%');
	});

	it('keeps Failed overlay at the last percent so a hung upload is not 100%', () => {
		const p = pending({
			name: 'clip.bin',
			transferred: 5,
			size: 100,
			status: 'failed',
			done: true
		});
		assert.equal(pendingLabel(p), 'Failed');
		assert.equal(pendingPercent(p), 5);
		assert.ok(pendingOverlay(p, true));
	});

	it('keeps Hashing… even when the dest file exists', () => {
		const p = pending({
			name: 'clip.wav',
			transferred: 100,
			size: 100,
			status: 'hashing'
		});
		assert.equal(pendingLabel(p), 'Hashing…');
		const rows = mergeListingWithPending([file('clip.wav')], [p]);
		assert.equal(rows[0].pending?.status, 'hashing');
	});

	it('root dest pending does not appear inside another folder or as a memory-wide ghost', () => {
		const p = pending({
			name: 'clip.wav',
			transferred: 50,
			destParentId: null
		});
		assert.equal(mergeListingWithPending([], [p], 'folder-a').length, 0);
		const root = mergeListingWithPending([], [p], null);
		assert.equal(root.length, 1);
		assert.equal(root[0]!.pending?.name, 'clip.wav');
	});

	it('does not show dest pending rows in a different folder (not root)', () => {
		const p = pending({
			name: 'hello.txt',
			transferred: 100,
			size: 100,
			destParentId: 'folder-a'
		});
		const rootRows = mergeListingWithPending([], [p], null);
		assert.equal(rootRows.length, 0);
		const destRows = mergeListingWithPending([], [p], 'folder-a');
		assert.equal(destRows.length, 1);
		assert.equal(destRows[0]!.placeholder, true);
		assert.equal(destRows[0]!.pending?.name, 'hello.txt');
		const listed = mergeListingWithPending([file('hello.txt', 'hello.txt')], [p], 'folder-a');
		assert.equal(listed[0]!.pending, null);
		assert.equal(listed[0]!.placeholder, false);
	});

	it('keeps driver file order so sibling reorder is visible', () => {
		const rows = mergeListingWithPending(
			[folder('Zed'), file('zebra.txt'), file('apple.txt')],
			[]
		);
		assert.deepEqual(
			rows.map((r) => r.node.name),
			['Zed', 'zebra.txt', 'apple.txt']
		);
	});

	it('attaches descendant progress to an existing dest folder', () => {
		const rows = mergeListingWithPending(
			[folder('repo'), file('other.txt')],
			[
				pending({
					name: 'repo',
					transferred: 40,
					size: 100,
					entryKind: 'folder',
					destParentId: null
				})
			]
		);
		const repo = rows.find((r) => r.node.name === 'repo');
		assert.ok(repo);
		assert.equal(repo.placeholder, false);
		assert.equal(repo.node.kind, 'folder');
		assert.ok(repo.pending);
		assert.equal(pendingPercent(repo.pending!), 40);
		assert.equal(repo.pending?.entryKind, 'folder');
	});

	it('shows a ghost folder placeholder for a nested extract dest', () => {
		const rows = mergeListingWithPending(
			[],
			[
				pending({
					name: 'repo',
					transferred: 10,
					size: 100,
					entryKind: 'folder',
					destParentId: null
				})
			],
			null
		);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.placeholder, true);
		assert.equal(rows[0]!.node.kind, 'folder');
		assert.equal(rows[0]!.pending?.name, 'repo');
	});

	it('does not treat a folder pending as a file with the same name', () => {
		const rows = mergeListingWithPending(
			[file('repo')],
			[
				pending({
					name: 'repo',
					transferred: 50,
					size: 100,
					entryKind: 'folder'
				})
			]
		);
		assert.equal(rows.length, 2);
		assert.equal(rows[0]!.node.kind, 'folder');
		assert.equal(rows[0]!.placeholder, true);
		assert.equal(rows[1]!.node.kind, 'file');
		assert.equal(rows[1]!.pending, null);
	});

	it('inserts unmatched pending among files by name without re-sorting existing files', () => {
		const rows = mergeListingWithPending(
			[folder('Zed'), file('zebra.txt'), file('apple.txt')],
			[pending({ name: 'aa-incoming.bin', transferred: 10 })]
		);
		assert.deepEqual(
			rows.map((r) => r.node.name),
			['Zed', 'aa-incoming.bin', 'zebra.txt', 'apple.txt']
		);
		assert.equal(rows[0].node.kind, 'folder');
		assert.equal(rows[1].placeholder, true);
	});
});
