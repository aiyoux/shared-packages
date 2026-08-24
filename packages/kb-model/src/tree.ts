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
	const rec = block as { type: string; open?: unknown };
	return rec.type === 'toggle' && rec.open === false;
}

function walk(blocks: Block[], out: Block[], visibleOnly: boolean): void {
	for (const block of blocks) {
		out.push(block);
		if (visibleOnly && isClosedToggle(block)) continue;
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
