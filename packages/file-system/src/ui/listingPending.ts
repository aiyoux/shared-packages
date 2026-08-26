/**
 * Merge in-flight transfer rows into the explorer listing so a copy/upload
 * occupies one line: translucent with a bar while bytes move, solid once the
 * dest file is in the listing (or still a 100% placeholder if the dest has
 * not listed it yet).
 */
import type { ExplorerEntry } from './explorerDriver.js';

export type ListingPending = {
	id: string;
	name: string;
	transferred: number;
	size: number;
	direction?: string;
	ready?: number;
	status?: string;
	done?: boolean;
};

export type ListingRow = {
	key: string;
	node: ExplorerEntry;
	pending: ListingPending | null;
	placeholder: boolean;
	nodeIndex: number | null;
};

export function pendingPercent(p: ListingPending): number {
	if (p.done || p.status === 'done') return 100;
	if (!p.size) return 0;
	return Math.min(100, Math.round((p.transferred / Math.max(p.size, 1)) * 100));
}

/** Bytes are in; dest write/hash may still be finishing. */
export function pendingBytesComplete(p: ListingPending): boolean {
	if (p.done || p.status === 'done') return true;
	return p.size > 0 && p.transferred >= p.size;
}

/**
 * Hide overlay when the dest listing already has the file and bytes are in.
 * Hashing/failed stay visible so the row can say what it is doing.
 */
export function pendingOverlay(
	p: ListingPending | undefined,
	nodeExists: boolean
): ListingPending | null {
	if (!p) return null;
	if (p.status === 'failed' || p.status === 'hashing') return p;
	if (nodeExists && pendingBytesComplete(p)) return null;
	return p;
}

export function pendingLabel(p: ListingPending): string {
	if (p.status === 'failed') return 'Failed';
	if (p.status === 'hashing') return 'Hashing…';
	const firstN = p.ready ?? p.transferred;
	const first = p.size ? Math.min(100, Math.round((firstN / Math.max(p.size, 1)) * 100)) : pendingPercent(p);
	const second = pendingPercent(p);
	if (first !== second) return `${first}% · ${second}%`;
	return `${second}%`;
}

function nameKey(name: string): string {
	return name.toLowerCase();
}

function lastPendingByName(pending: ListingPending[]): Map<string, ListingPending> {
	const map = new Map<string, ListingPending>();
	for (const p of pending) {
		if (!p.name) continue;
		map.set(nameKey(p.name), p);
	}
	return map;
}

function placeholderEntry(p: ListingPending, parentId: ExplorerEntry['parentId']): ExplorerEntry {
	return {
		id: `pending:${p.id}`,
		parentId,
		name: p.name,
		kind: 'file',
		size: p.size || undefined
	};
}

function cmpName(a: string, b: string): number {
	return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}

/**
 * Folders first (existing list order), then files + unmatched pending
 * placeholders sorted by name. Matching dest files reuse the live row.
 */
export function mergeListingWithPending(
	nodes: ExplorerEntry[],
	pending: ListingPending[],
	parentId: ExplorerEntry['parentId'] = null
): ListingRow[] {
	const byName = lastPendingByName(pending);
	const used = new Set<string>();
	const folders: ListingRow[] = [];
	const files: ListingRow[] = [];

	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i]!;
		if (n.kind === 'folder') {
			folders.push({
				key: n.id,
				node: n,
				pending: null,
				placeholder: false,
				nodeIndex: i
			});
			continue;
		}
		const p = byName.get(nameKey(n.name));
		if (p) used.add(nameKey(n.name));
		files.push({
			key: n.id,
			node: n,
			pending: pendingOverlay(p, true),
			placeholder: false,
			nodeIndex: i
		});
	}

	for (const p of pending) {
		const key = nameKey(p.name);
		if (!p.name || used.has(key)) continue;
		used.add(key);
		files.push({
			key: `pending:${p.id}`,
			node: placeholderEntry(p, parentId),
			pending: p,
			placeholder: true,
			nodeIndex: null
		});
	}

	files.sort((a, b) => cmpName(a.node.name, b.node.name));
	return [...folders, ...files];
}
