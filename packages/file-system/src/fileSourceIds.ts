/** File identities keep the storage location through editor/session handoffs. */
export const MEMORY_FILE_PREFIX = 'memory:';
export const DISK_FILE_PREFIX = 'disk:';

export function memoryFileId(id: string): string {
	return id.startsWith(MEMORY_FILE_PREFIX) ? id : MEMORY_FILE_PREFIX + id;
}

export function isEphemeralFileId(id: string | null | undefined): boolean {
	return !!id?.startsWith(MEMORY_FILE_PREFIX);
}

export function diskFileId(rootId: string, path: string): string {
	return `${DISK_FILE_PREFIX}${rootId}:${encodeURIComponent(path)}`;
}

export function diskFileLocation(id: string): { rootId: string; path: string } | null {
	if (!id.startsWith(DISK_FILE_PREFIX)) return null;
	const split = id.indexOf(':', DISK_FILE_PREFIX.length);
	if (split < 0) return null;
	try {
		const rootId = id.slice(DISK_FILE_PREFIX.length, split);
		const path = decodeURIComponent(id.slice(split + 1));
		if (!rootId || path.split('/').some((part) => part === '..' || part === '.')) return null;
		return { rootId, path };
	} catch { return null; }
}
