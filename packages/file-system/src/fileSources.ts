/** Source access for editor IDs. No importing Memory/Disk bytes into the catalog. */
import { getMemoryVfs, toVfsNodeLike } from './memoryVfs.js';
import { diskFileLocation, isEphemeralFileId, memoryFileId, MEMORY_FILE_PREFIX } from './fileSourceIds.js';
import type { VfsNode, UpdateFileOpts, WriteFileInput, VfsListOptions } from './types.js';
import { createChangeBus } from './changeBus.js';

export interface FileSource {
	get(id: string): Promise<VfsNode | undefined>;
	readBlob(id: string): Promise<Blob>;
	updateFile(id: string, body: unknown, opts: UpdateFileOpts): Promise<VfsNode>;
	list(opts: VfsListOptions): Promise<VfsNode[]>;
	writeFile(input: WriteFileInput): Promise<VfsNode>;
	mkdir(parentId: string, name: string): Promise<VfsNode>;
}

export const SOURCE_FILES_CHANNEL = 'file-source-handles';
export const sourceChanges = createChangeBus();

const memoryNode = (node: Parameters<typeof toVfsNodeLike>[0]): VfsNode => ({
	...toVfsNodeLike(node), id: memoryFileId(node.id), parentId: MEMORY_FILE_PREFIX
});

const memory: FileSource = {
	async get(id) {
		// A source root represents the flat collection to folder-based loaders.
		// It adds no folders or durable entries to Memory itself.
		if (id === MEMORY_FILE_PREFIX) return { id, parentId: null, name: 'In memory', kind: 'folder', generation: 1, createdAt: 0, updatedAt: 0 };
		const node = await getMemoryVfs().get(id.slice(MEMORY_FILE_PREFIX.length));
		return node ? memoryNode(node) : undefined;
	},
	readBlob: (id) => getMemoryVfs().readBlob(id.slice(MEMORY_FILE_PREFIX.length)),
	async updateFile(id, body, opts) { return memoryNode(await getMemoryVfs().updateFile(id.slice(MEMORY_FILE_PREFIX.length), body, opts)); },
	async list(opts) { return (await getMemoryVfs().list({ ...opts, parentId: null })).map(memoryNode); },
	async writeFile(input) { return memoryNode(await getMemoryVfs().writeFile({ ...input, parentId: null })); },
	async mkdir() { throw new Error('Memory files have no folders'); }
};

export async function fileSource(id: string | null | undefined): Promise<FileSource | null> {
	if (isEphemeralFileId(id)) return memory;
	if (id && diskFileLocation(id)) {
		const { diskFileSource } = await import('./disk/fileSource.js');
		return diskFileSource;
	}
	return null;
}
