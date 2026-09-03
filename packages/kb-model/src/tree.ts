import { isUnknownBlock } from './plaintext.js';
import type { Block, KbPage } from './types.js';

export type ParentRef = Block | 'page';

export type BlockParent = {
	parent: ParentRef;
	index: number;
};

export type BlockLocation = {
	block: Block;
	parent: ParentRef;
	index: number;
};

export function blockChildren(block: Block): Block[] | undefined {
	const kids = (block as Block & { children?: unknown }).children;
	return Array.isArray(kids) ? kids : undefined;
}

export function childrenOf(page: KbPage, parent: ParentRef): Block[] {
	if (parent === 'page') return page.blocks;
	const kids = blockChildren(parent);
	if (!kids) throw new Error(`block ${parent.id} has no children list`);
	return kids;
}

export function sameParent(a: ParentRef, b: ParentRef): boolean {
	if (a === 'page' || b === 'page') return a === b;
	return a.id === b.id;
}

function isClosedToggle(block: Block): boolean {
	return block.type === 'toggle' && block.open === false;
}

function walk(blocks: Block[], out: Block[], visibleOnly: boolean): void {
	for (const block of blocks) {
		out.push(block);
		if (visibleOnly && isClosedToggle(block)) continue;
		// Unknown blocks are opaque: their children are preserved but never traversed.
		if (isUnknownBlock(block)) continue;
		const kids = blockChildren(block);
		if (kids) walk(kids, out, visibleOnly);
	}
}

/** DFS; includes hidden toggle children. */
export function documentOrder(page: KbPage): Block[] {
	const out: Block[] = [];
	walk(page.blocks ?? [], out, false);
	return out;
}

/** DFS, omits closed-toggle children. */
export function visibleOrder(page: KbPage): Block[] {
	const out: Block[] = [];
	walk(page.blocks ?? [], out, true);
	return out;
}

function locate(
	blocks: Block[],
	parent: ParentRef,
	id: string
): BlockLocation | undefined {
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		if (block.id === id) return { block, parent, index: i };
		// Unknown blocks are opaque: never locate inside them.
		if (isUnknownBlock(block)) continue;
		const kids = blockChildren(block);
		if (kids) {
			const found = locate(kids, block, id);
			if (found) return found;
		}
	}
	return undefined;
}

export function locateBlock(page: KbPage, id: string): BlockLocation | undefined {
	return locate(page.blocks ?? [], 'page', id);
}

export function findBlock(page: KbPage, id: string): Block | undefined {
	return locateBlock(page, id)?.block;
}

export function parentOf(page: KbPage, id: string): BlockParent | undefined {
	const found = locateBlock(page, id);
	if (!found) return undefined;
	return { parent: found.parent, index: found.index };
}

export function parentIdOf(parent: ParentRef): string | null {
	return parent === 'page' ? null : parent.id;
}

export function isDescendant(page: KbPage, ancestorId: string, maybeChildId: string): boolean {
	if (ancestorId === maybeChildId) return false;
	const ancestor = findBlock(page, ancestorId);
	if (!ancestor) return false;
	const ids: string[] = [];
	collectIds(ancestor, ids);
	return ids.includes(maybeChildId);
}

function collectIds(block: Block, into: string[]): void {
	into.push(block.id);
	if (isUnknownBlock(block)) return;
	const kids = blockChildren(block);
	if (kids) for (const child of kids) collectIds(child, into);
}

export function subtreeContains(block: Block, id: string): boolean {
	if (block.id === id) return true;
	const kids = blockChildren(block);
	if (!kids) return false;
	return kids.some((child) => subtreeContains(child, id));
}

export function lastDescendantId(block: Block): string {
	if (isUnknownBlock(block)) return block.id;
	const kids = blockChildren(block);
	if (!kids || kids.length === 0) return block.id;
	return lastDescendantId(kids[kids.length - 1]);
}
