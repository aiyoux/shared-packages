/**
 * Narrow File System Access handle surface so the driver can run against
 * real directory handles or an in-memory mock (tests).
 */

export type DiskFileHandle = {
	kind: 'file';
	name: string;
	getFile(): Promise<File>;
	createWritable(): Promise<{
		write(data: BufferSource | Blob | string): Promise<void>;
		close(): Promise<void>;
	}>;
};

export type DiskDirHandle = {
	kind: 'directory';
	name: string;
	entries(): AsyncIterableIterator<[string, DiskDirHandle | DiskFileHandle]>;
	getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DiskDirHandle>;
	getFileHandle(name: string, opts?: { create?: boolean }): Promise<DiskFileHandle>;
	removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
	queryPermission?(opts?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
	requestPermission?(opts?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
};

export function canPickDirectory(): boolean {
	return typeof globalThis !== 'undefined' && typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

export async function pickDirectory(): Promise<DiskDirHandle> {
	const w = globalThis as unknown as {
		showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<DiskDirHandle>;
	};
	if (!w.showDirectoryPicker) {
		throw new Error('DIRECTORY_PICKER_UNSUPPORTED');
	}
	return w.showDirectoryPicker({ mode: 'readwrite' });
}
