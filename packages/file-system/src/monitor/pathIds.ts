/**
 * Monitor entry identity: paths relative to profile rootPath.
 * Folders end with `/`. Absolute host paths are built for the monitor API.
 */

function rejectUnsafe(seg: string): void {
	if (seg === '' || seg === '.' || seg === '..') throw new Error('INVALID_PATH');
	if (seg.includes('\0')) throw new Error('INVALID_PATH');
}

/** Single path segment: no `/`, `.`, `..`, or empty. */
export function sanitizeSegment(name: string): string {
	const n = name.trim();
	if (!n || n === '.' || n === '..' || n.includes('/') || n.includes('\0')) {
		throw new Error('INVALID_NAME');
	}
	return n;
}

/** Absolute host path for list/stat/read given root + relative entry id. */
export function toAbsolutePath(rootPath: string, entryId: string | null): string {
	const root = rootPath === '/' ? '/' : rootPath.replace(/\/+$/, '');
	if (entryId == null || entryId === '') return root;

	let id = entryId.replace(/^\/+/, '');
	const isDir = id.endsWith('/');
	const bare = id.replace(/\/+$/, '');
	const segs = bare ? bare.split('/') : [];
	for (const s of segs) rejectUnsafe(s);

	if (!bare) return root;
	if (root === '/') return `/${bare}${isDir ? '/' : ''}`.replace(/\/+$/, isDir ? '' : '') || '/';
	// For files: /root/bare; for dirs we still pass without trailing slash to monitor
	return `${root}/${bare}`;
}

export function childId(parentId: string | null, name: string, isDir: boolean): string {
	const seg = name.trim();
	rejectUnsafe(seg);
	if (parentId == null || parentId === '') {
		return isDir ? `${seg}/` : seg;
	}
	const parent = parentId.replace(/\/+$/, '');
	const base = parent ? `${parent}/${seg}` : seg;
	return isDir ? `${base}/` : base;
}

export function baseName(id: string): string {
	const bare = id.replace(/\/+$/, '');
	const i = bare.lastIndexOf('/');
	return i >= 0 ? bare.slice(i + 1) : bare;
}

export function isFolderId(id: string): boolean {
	return id.endsWith('/');
}

export function parentIdOf(id: string): string | null {
	const bare = id.replace(/\/+$/, '');
	const i = bare.lastIndexOf('/');
	if (i < 0) return null;
	const parent = bare.slice(0, i);
	return parent ? `${parent}/` : null;
}

export function breadcrumbChain(id: string): { id: string; parentId: string | null; name: string }[] {
	if (!id || id === '/') return [];
	const parts: { id: string; parentId: string | null; name: string }[] = [];
	let cur: string | null = isFolderId(id) ? id : parentIdOf(id);
	// For files, breadcrumbs are parents only; for folders include self
	if (isFolderId(id)) {
		const chain: string[] = [];
		let c: string | null = id;
		while (c) {
			chain.unshift(c);
			c = parentIdOf(c);
		}
		for (let i = 0; i < chain.length; i++) {
			const cid = chain[i]!;
			parts.push({
				id: cid,
				parentId: i === 0 ? null : chain[i - 1]!,
				name: baseName(cid)
			});
		}
		return parts;
	}
	// file: parents as folders
	const segs = id.replace(/\/+$/, '').split('/').filter(Boolean);
	let acc = '';
	for (let i = 0; i < segs.length - 1; i++) {
		acc = acc ? `${acc}/${segs[i]}` : segs[i]!;
		const folderId = `${acc}/`;
		parts.push({
			id: folderId,
			parentId: i === 0 ? null : `${segs.slice(0, i).join('/')}/`,
			name: segs[i]!
		});
	}
	return parts;
}

/** Relative entry id from absolute path under root. */
export function relativeIdFromAbsolute(
	rootPath: string,
	absolute: string,
	isDir: boolean
): string {
	const root = rootPath === '/' ? '/' : rootPath.replace(/\/+$/, '');
	let abs = absolute;
	if (abs !== '/') abs = abs.replace(/\/+$/, '');
	if (abs === root || (root === '/' && abs === '/')) return '';
	let rel: string;
	if (root === '/') {
		rel = abs.replace(/^\//, '');
	} else if (abs.startsWith(root + '/')) {
		rel = abs.slice(root.length + 1);
	} else if (abs === root) {
		return '';
	} else {
		throw new Error('PATH_OUTSIDE_ROOT');
	}
	return isDir ? (rel ? `${rel}/` : '') : rel;
}
