import {
	closeLeaf,
	createLeaf,
	leafCount,
	listLeaves,
	splitLeaf
} from '../pane-layout/tree.js';
import type { LayoutNode, SplitDirection } from '../pane-layout/types.js';
import type { AppWindowLeaf, AppWindowRoleDef } from './types.js';

export function createAppWindowRoot(leafId: string): LayoutNode {
	return createLeaf(leafId);
}

export function defaultAppWindows<R extends string>(
	leafId: string,
	role: R
): Record<string, AppWindowLeaf<R>> {
	return { [leafId]: { role } };
}

export function pickNewRole<R extends string>(
	windows: Record<string, AppWindowLeaf<R>>,
	sourceRole: R,
	catalog: readonly AppWindowRoleDef<R>[],
	available?: ReadonlySet<R>
): R {
	const source = catalog.find((c) => c.id === sourceRole);
	if (source?.required) return sourceRole;
	const used = new Set(Object.values(windows).map((w) => w.role));
	const ok = (role: AppWindowRoleDef<R>) =>
		!role.required &&
		role.autoPick !== false &&
		(!available || available.has(role.id));
	for (const role of catalog) {
		if (!ok(role)) continue;
		if (!used.has(role.id)) return role.id;
	}
	return catalog.find(ok)?.id ?? sourceRole;
}

export function roleCount<R extends string>(
	windows: Record<string, AppWindowLeaf<R>>,
	role: R
): number {
	return Object.values(windows).filter((w) => w.role === role).length;
}

export function canCloseAppWindow<R extends string>(
	root: LayoutNode,
	windows: Record<string, AppWindowLeaf<R>>,
	leafId: string,
	catalog: readonly AppWindowRoleDef<R>[]
): boolean {
	if (leafCount(root) <= 1) return false;
	const current = windows[leafId];
	if (!current) return false;
	const def = catalog.find((c) => c.id === current.role);
	if (def?.required && roleCount(windows, current.role) <= 1) return false;
	return true;
}

export function splitAppWindow<S extends AppWindowLeaf<R>, R extends string>(
	root: LayoutNode,
	windows: Record<string, S>,
	leafId: string,
	direction: SplitDirection,
	catalog: readonly AppWindowRoleDef<R>[],
	inherit: (source: S | undefined, role: R) => S,
	available?: ReadonlySet<R>
): { root: LayoutNode; windows: Record<string, S>; newId: string } | null {
	const next = splitLeaf(root, leafId, direction);
	if (!next) return null;
	const role = pickNewRole(
		windows,
		windows[leafId]?.role ?? catalog[0]!.id,
		catalog,
		available
	);
	return {
		root: next.root,
		windows: {
			...windows,
			[next.newLeaf.id]: inherit(windows[leafId], role)
		},
		newId: next.newLeaf.id
	};
}

export function closeAppWindow<S extends AppWindowLeaf<R>, R extends string>(
	root: LayoutNode,
	windows: Record<string, S>,
	leafId: string,
	catalog: readonly AppWindowRoleDef<R>[]
): { root: LayoutNode; windows: Record<string, S> } | null {
	if (!canCloseAppWindow(root, windows, leafId, catalog)) return null;
	const nextRoot = closeLeaf(root, leafId);
	if (nextRoot === root) return null;
	const keep = new Set(listLeaves(nextRoot).map((l) => l.id));
	const windowsNext: Record<string, S> = {};
	for (const id of keep) {
		if (windows[id]) windowsNext[id] = windows[id];
	}
	return { root: nextRoot, windows: windowsNext };
}

export function setAppWindowRole<S extends AppWindowLeaf<R>, R extends string>(
	windows: Record<string, S>,
	leafId: string,
	role: R,
	catalog: readonly AppWindowRoleDef<R>[],
	inherit: (source: S | undefined, role: R) => S
): Record<string, S> | null {
	const current = windows[leafId];
	if (!current) return null;
	if (current.role === role) return windows;
	const def = catalog.find((c) => c.id === current.role);
	if (def?.required && role !== current.role && roleCount(windows, current.role) <= 1) {
		return null;
	}
	return { ...windows, [leafId]: inherit(current, role) };
}

/** Drop or reassign leaves whose role is no longer available. */
export function clampUnavailableRoles<S extends AppWindowLeaf<R>, R extends string>(
	windows: Record<string, S>,
	available: ReadonlySet<R>,
	fallback: R,
	inherit: (source: S | undefined, role: R) => S
): Record<string, S> {
	let changed = false;
	const next: Record<string, S> = {};
	for (const [id, w] of Object.entries(windows)) {
		if (available.has(w.role)) {
			next[id] = w;
		} else {
			changed = true;
			next[id] = inherit(w, fallback);
		}
	}
	return changed ? next : windows;
}

/** Resolve the active target window leaf ID. */
export function resolveTargetLeafId<S extends AppWindowLeaf<R>, R extends string>(
	windows: Record<string, S>,
	focusedId: string,
	previousTarget?: string,
	targetRole?: R
): string {
	if (targetRole) {
		if (windows[focusedId]?.role === targetRole) return focusedId;
		if (previousTarget && windows[previousTarget]?.role === targetRole) return previousTarget;
		const match = Object.keys(windows).find((id) => windows[id]?.role === targetRole);
		if (match) return match;
	} else {
		if (windows[focusedId]) return focusedId;
		if (previousTarget && windows[previousTarget]) return previousTarget;
	}
	return Object.keys(windows)[0] ?? focusedId;
}
