/**
 * rclone entry identity: fs-relative paths under optional rootPath.
 * Folders use trailing `/`. Absolute paths and `..` are rejected.
 */

export type PathParts = {
	/** Path relative to profile root (no leading slash); dirs end with `/` */
	rel: string;
	/** true if this id is a folder */
	isDir: boolean;
};

function rejectUnsafe(seg: string): void {
	if (seg === '' || seg === '.' || seg === '..') {
		throw new Error('INVALID_PATH');
	}
	if (seg.includes('\0')) throw new Error('INVALID_PATH');
}

/**
 * Normalize a remote path under `rootPath`.
 * - strips leading `/`
 * - rejects absolute-ish and `..`
 * - folders keep trailing `/` when `asDir` or input ends with `/`
 */
export function encodePathId(
	rootPath: string,
	remoteUnderRoot: string,
	opts?: { asDir?: boolean }
): string {
	const root = rootPath.replace(/^\/+|\/+$/g, '');
	let rel = (remoteUnderRoot ?? '').trim().replace(/^\/+/, '');
	const wantDir = opts?.asDir === true || rel.endsWith('/');
	rel = rel.replace(/\/+$/, '');

	const segs = rel ? rel.split('/').filter(Boolean) : [];
	for (const s of segs) rejectUnsafe(s);

	let under = segs.join('/');
	if (root) {
		// remoteUnderRoot is already relative to root when coming from driver internals
		under = under ? under : '';
	}

	if (!under) {
		// effective root is not an entry id used as parentId null
		return wantDir ? '' : '';
	}
	return wantDir ? `${under}/` : under;
}

/**
 * Join rootPath + entry id → path relative to fs (for RC `remote` param).
 * Entry id is relative to root; result has no leading slash.
 */
export function toRemoteParam(rootPath: string, entryId: string | null): string {
	const root = (rootPath ?? '').replace(/^\/+|\/+$/g, '');
	if (entryId == null || entryId === '') {
		return root;
	}
	let id = entryId.replace(/^\/+/, '');
	// validate
	const isDir = id.endsWith('/');
	const bare = id.replace(/\/+$/, '');
	const segs = bare ? bare.split('/') : [];
	for (const s of segs) rejectUnsafe(s);

	if (!root) {
		return isDir ? (bare ? `${bare}/` : '') : bare;
	}
	if (!bare) return isDir ? `${root}/` : root;
	return isDir ? `${root}/${bare}/` : `${root}/${bare}`;
}

/**
 * parentId for list: null means effective root.
 * Child id relative to root.
 */
export function childId(parentId: string | null, name: string, isDir: boolean): string {
	const seg = name.trim();
	rejectUnsafe(seg);
	if (seg.includes('/')) throw new Error('INVALID_PATH');
	const base = parentId ? parentId.replace(/\/+$/, '') + '/' : '';
	return isDir ? `${base}${seg}/` : `${base}${seg}`;
}

export function parentIdOf(entryId: string): string | null {
	let id = entryId.replace(/^\/+/, '');
	const isDir = id.endsWith('/');
	const bare = id.replace(/\/+$/, '');
	if (!bare) return null;
	const i = bare.lastIndexOf('/');
	if (i < 0) return null;
	// parent folder always trailing slash when non-root
	return bare.slice(0, i + 1);
}

export function baseName(entryId: string): string {
	const bare = entryId.replace(/\/+$/, '');
	const i = bare.lastIndexOf('/');
	return i >= 0 ? bare.slice(i + 1) : bare;
}

export function isFolderId(entryId: string): boolean {
	return entryId.endsWith('/');
}

/**
 * Breadcrumb chain from effective root to `id` (folder chain only; exclusive of file leaf).
 * When id is a file, chain is parent folders. When folder, includes that folder.
 */
export function breadcrumbChain(entryId: string): Array<{ id: string; name: string; parentId: string | null }> {
	const bare = entryId.replace(/\/+$/, '');
	if (!bare) return [];
	const segs = bare.split('/').filter(Boolean);
	// if original was a file, last segment is the file — breadcrumbs are parents only for getPath
	// getPath in design: chain from root to id exclusive of root chrome.
	// B2 includes folder segments for the path of a folder id.
	const isDir = entryId.endsWith('/');
	const folderSegs = isDir ? segs : segs.slice(0, -1);
	const chain: Array<{ id: string; name: string; parentId: string | null }> = [];
	let acc = '';
	for (let i = 0; i < folderSegs.length; i++) {
		const name = folderSegs[i]!;
		const parentId = i === 0 ? null : acc;
		acc = acc ? `${acc.replace(/\/+$/, '')}/${name}/` : `${name}/`;
		chain.push({ id: acc, name, parentId });
	}
	return chain;
}

export function sanitizeSegment(name: string): string {
	const n = name.trim();
	if (!n || n === '.' || n === '..' || n.includes('/')) {
		throw new Error('INVALID_NAME');
	}
	return n;
}
