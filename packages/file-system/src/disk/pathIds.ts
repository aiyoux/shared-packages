/**
 * Path ids for the native-disk explorer: relative to the picked root.
 * Folders end with `/`. `parentId === null` is the picked directory.
 */

export function joinId(parentId: string | null, name: string, isDir: boolean): string {
	const base = parentId ? parentId.replace(/\/+$/, '') : '';
	const id = base ? `${base}/${name}` : name;
	return isDir ? `${id}/` : id;
}

export function parentIdOf(id: string): string | null {
	const bare = id.replace(/\/+$/, '');
	const i = bare.lastIndexOf('/');
	if (i < 0) return null;
	return `${bare.slice(0, i)}/`;
}

export function baseName(id: string): string {
	const bare = id.replace(/\/+$/, '');
	const i = bare.lastIndexOf('/');
	return i < 0 ? bare : bare.slice(i + 1);
}

export function pathSegments(id: string | null): string[] {
	if (!id) return [];
	return id.replace(/\/+$/, '').split('/').filter(Boolean);
}

export function isFolderId(id: string): boolean {
	return id.endsWith('/');
}
