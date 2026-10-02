/**
 * Dual-mount path helpers: stand-alone (base '') or under the hub
 * (`/tools/<product>`), one shared shape for every product that mounts both
 * ways. Each app's `mount({ base })` calls `setWorkspaceBase` once at boot;
 * route mapping then strips or prepends that base.
 */
let workspaceBase = '';

/** Empty or `/` normalizes to `''`; trailing slashes are stripped. */
export function setWorkspaceBase(base: string): void {
	if (!base || base === '/') {
		workspaceBase = '';
		return;
	}
	workspaceBase = base.endsWith('/') ? base.slice(0, -1) : base;
}

export function getWorkspaceBase(): string {
	return workspaceBase;
}

/** Strip a single trailing slash, leaving `/` alone. */
function stripTrailingSlash(path: string): string {
	if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
	return path;
}

/**
 * Strip the workspace base from a pathname, returning the relative path
 * (always starting with `/`), or `null` if the path is outside the base.
 */
export function stripWorkspaceBase(path: string): string | null {
	const base = workspaceBase;
	if (!base) return path;
	const normalized = stripTrailingSlash(path);
	if (normalized === base) return '/';
	if (normalized.startsWith(base + '/')) {
		return normalized.slice(base.length) || '/';
	}
	return null;
}

/** Map relative workspace path to absolute URL path. */
export function workspacePath(relative: string): string {
	const rel =
		!relative || relative === '/'
			? '/'
			: relative.startsWith('/')
				? relative
				: `/${relative}`;
	const base = workspaceBase;
	if (!base) return rel;
	if (rel === '/') return base;
	return base + rel;
}

/** True if pathname matches a relative workspace path (e.g. '/library'). */
export function pathMatches(pathname: string, relative: string): boolean {
	const r = stripWorkspaceBase(pathname);
	if (r === null) return false;
	const want = !relative || relative === '/' ? '/' : relative.startsWith('/') ? relative : `/${relative}`;
	return stripTrailingSlash(r) === stripTrailingSlash(want);
}