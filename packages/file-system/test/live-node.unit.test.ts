import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	getLiveFile,
	getLiveFolder,
	isLiveFileNode,
	isLiveFolderNode,
	isLiveVfsNode
} from '../src/liveNode.ts';

describe('isLiveVfsNode', () => {
	it('rejects missing and trash', () => {
		assert.equal(isLiveVfsNode(undefined), false);
		assert.equal(isLiveVfsNode({ deletedAt: 1 }), false);
		assert.equal(isLiveVfsNode({ deletedAt: null }), true);
	});
});

describe('isLiveFileNode / isLiveFolderNode', () => {
	it('requires kind and not trash', () => {
		assert.equal(isLiveFileNode({ kind: 'file', deletedAt: null }), true);
		assert.equal(isLiveFileNode({ kind: 'folder', deletedAt: null }), false);
		assert.equal(isLiveFileNode({ kind: 'file', deletedAt: 9 }), false);
		assert.equal(isLiveFolderNode({ kind: 'folder', deletedAt: null }), true);
		assert.equal(isLiveFolderNode({ kind: 'file', deletedAt: null }), false);
	});
});

describe('getLiveFile / getLiveFolder', () => {
	it('returns only live rows of the asked kind', async () => {
		const nodes = new Map([
			['a', { kind: 'file' as const, deletedAt: null }],
			['b', { kind: 'file' as const, deletedAt: 1 }],
			['c', { kind: 'folder' as const, deletedAt: null }]
		]);
		const vfs = {
			get: async (id: string) => nodes.get(id) as never
		};
		assert.equal((await getLiveFile(vfs, 'a'))?.kind, 'file');
		assert.equal(await getLiveFile(vfs, 'b'), undefined);
		assert.equal(await getLiveFile(vfs, 'c'), undefined);
		assert.equal((await getLiveFolder(vfs, 'c'))?.kind, 'folder');
		assert.equal(await getLiveFolder(vfs, 'a'), undefined);
	});
});
