export type Zone = 'before' | 'after' | 'into';

export type TreeNode<K extends string = string, M = unknown> = {
	id: string;
	kind: K;
	label: string;
	children?: TreeNode<K, M>[];
	meta?: M;
	/** When true the row shows a chevron even with no children yet. */
	expandable?: boolean;
	/** Studio row states painted by tree.css (`unread` | `hidden` | `active`). */
	state?: 'unread' | 'hidden' | 'active' | (string & {});
	/** Keep hover-reveal actions visible (open menus). */
	actionsOpen?: boolean;
	/** Muted trailing metadata, e.g. an ink count. */
	detail?: string;
	/** Optional Playwright hook. */
	testId?: string;
	/** Extra attributes on the row wrapper (e.g. data-hidden-in-pinned). */
	data?: Record<string, string>;
};

export type TreeDrag<K extends string = string, M = unknown> = {
	kind: K;
	id: string;
	meta?: M;
};

export type DropPolicy<K extends string = string, M = unknown> = (
	drag: TreeDrag<K, M>,
	over: TreeDrag<K, M>
) => Zone[];

export type FlatRow<K extends string = string, M = unknown> = {
	node: TreeNode<K, M>;
	parentId: string | null;
	depth: number;
};

export function isExpandable<K extends string, M>(node: TreeNode<K, M>): boolean {
	return Boolean(node.expandable || (node.children && node.children.length > 0));
}

export function toIdSet(ids: Iterable<string> | undefined | null): Set<string> {
	if (!ids) return new Set();
	return ids instanceof Set ? ids : new Set(ids);
}

export function flattenVisible<K extends string, M>(
	items: TreeNode<K, M>[],
	expandedIds: Iterable<string> | undefined | null,
	parentId: string | null = null,
	depth = 0
): FlatRow<K, M>[] {
	const expanded = toIdSet(expandedIds);
	const out: FlatRow<K, M>[] = [];
	for (const node of items) {
		out.push({ node, parentId, depth });
		if (node.children?.length && expanded.has(node.id)) {
			out.push(...flattenVisible(node.children, expanded, node.id, depth + 1));
		}
	}
	return out;
}

export function indexNodes<K extends string, M>(
	items: TreeNode<K, M>[],
	into: Map<string, TreeNode<K, M>> = new Map()
): Map<string, TreeNode<K, M>> {
	for (const node of items) {
		into.set(node.id, node);
		if (node.children?.length) indexNodes(node.children, into);
	}
	return into;
}

export type KeyboardResult = {
	selectId?: string;
	toggleId?: string;
	activateId?: string;
};

/**
 * Arrow/Enter keyboard target among currently visible rows.
 * Left on an expanded node collapses; left on a leaf (or collapsed node) jumps
 * to the parent. Right expands. Up/down move selection. Enter activates.
 */
export function keyboardTarget<K extends string, M>(
	rows: FlatRow<K, M>[],
	selectedId: string | null | undefined,
	key: string,
	expandedIds: Iterable<string> | undefined | null
): KeyboardResult | null {
	if (rows.length === 0) return null;
	const expanded = toIdSet(expandedIds);
	const idx = selectedId ? rows.findIndex((r) => r.node.id === selectedId) : -1;

	if (key === 'ArrowDown') {
		if (idx < 0) return { selectId: rows[0].node.id };
		if (idx < rows.length - 1) return { selectId: rows[idx + 1].node.id };
		return null;
	}
	if (key === 'ArrowUp') {
		if (idx < 0) return { selectId: rows[0].node.id };
		if (idx > 0) return { selectId: rows[idx - 1].node.id };
		return null;
	}
	if (key === 'Enter') {
		if (idx < 0) return null;
		return { activateId: rows[idx].node.id, selectId: rows[idx].node.id };
	}
	if (key === 'ArrowRight') {
		if (idx < 0) return { selectId: rows[0].node.id };
		const row = rows[idx];
		if (isExpandable(row.node) && !expanded.has(row.node.id)) {
			return { toggleId: row.node.id };
		}
		if (idx < rows.length - 1) return { selectId: rows[idx + 1].node.id };
		return null;
	}
	if (key === 'ArrowLeft') {
		if (idx < 0) return null;
		const row = rows[idx];
		if (isExpandable(row.node) && expanded.has(row.node.id)) {
			return { toggleId: row.node.id };
		}
		if (row.parentId) return { selectId: row.parentId };
		return null;
	}
	return null;
}
