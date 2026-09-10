import type { VfsNode } from './types.js';

/** Present in the catalog and not in the trash. */
export function isLiveVfsNode<T extends { deletedAt?: number | null }>(
	node: T | null | undefined
): node is T {
	return node != null && node.deletedAt == null;
}

export function isLiveFileNode<T extends { kind?: string; deletedAt?: number | null }>(
	node: T | null | undefined
): node is T & { kind: 'file' } {
	return isLiveVfsNode(node) && node.kind === 'file';
}

export function isLiveFolderNode<T extends { kind?: string; deletedAt?: number | null }>(
	node: T | null | undefined
): node is T & { kind: 'folder' } {
	return isLiveVfsNode(node) && node.kind === 'folder';
}

export async function getLiveVfsNode(
	vfs: { get(id: string): Promise<VfsNode | undefined> },
	id: string
): Promise<VfsNode | undefined> {
	const node = await vfs.get(id).catch(() => undefined);
	return isLiveVfsNode(node) ? node : undefined;
}

export async function getLiveFile(
	vfs: { get(id: string): Promise<VfsNode | undefined> },
	id: string
): Promise<VfsNode | undefined> {
	const node = await getLiveVfsNode(vfs, id);
	return isLiveFileNode(node) ? node : undefined;
}

export async function getLiveFolder(
	vfs: { get(id: string): Promise<VfsNode | undefined> },
	id: string
): Promise<VfsNode | undefined> {
	const node = await getLiveVfsNode(vfs, id);
	return isLiveFolderNode(node) ? node : undefined;
}
