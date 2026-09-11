import {
	childrenOf,
	findBlock,
	isContainer,
	isDescendant,
	isTableStructure,
	parentIdOf,
	parentOf,
	plaintextOf,
	visibleOrder,
	type Block,
	type KbPage,
	type Range
} from '@shared-packages/doc-model';
import { PARENT_ID_ATTR } from './project.js';
import { collapsed } from './range.js';

export type DropPosition = {
	id: string;
	afterId: string | null;
	parentId: string | null;
};

export type DropTarget = { afterId: string | null; parentId: string | null };

export type OverlayBox = { parentId: string; top: number; height: number };

function prevSiblingId(page: KbPage, loc: NonNullable<ReturnType<typeof parentOf>>): string | null {
	if (loc.index === 0) return null;
	return childrenOf(page, loc.parent)[loc.index - 1].id;
}

function alreadyThere(
	page: KbPage,
	from: NonNullable<ReturnType<typeof parentOf>>,
	afterId: string | null,
	parentId: string | null
): boolean {
	if (parentIdOf(from.parent) !== parentId) return false;
	return prevSiblingId(page, from) === afterId;
}

/** Map a drop onto a target handle to move-block { afterId, parentId }. */
export function dropTarget(
	page: KbPage,
	draggedId: string,
	targetId: string,
	where: 'before' | 'after'
): DropTarget | 'noop' {
	if (draggedId === targetId) return 'noop';
	const fromLoc = parentOf(page, draggedId);
	const toLoc = parentOf(page, targetId);
	if (!fromLoc || !toLoc) return 'noop';
	const dragged = findBlock(page, draggedId);
	const target = findBlock(page, targetId);
	if (!dragged || !target) return 'noop';
	if (isDescendant(page, draggedId, targetId)) return 'noop';
	if (dragged.type === 'table_row' || dragged.type === 'table_cell') return 'noop';
	if (target.type === 'table_row' || target.type === 'table_cell') return 'noop';
	if (toLoc.parent !== 'page' && isTableStructure(toLoc.parent)) return 'noop';

	if (isContainer(target) && where === 'after') {
		if (isContainer(dragged) || dragged.type === 'table') return 'noop';
		if (fromLoc.parent !== 'page' && fromLoc.parent.id === target.id && fromLoc.index === 0) {
			return 'noop';
		}
		return { afterId: null, parentId: target.id };
	}

	const parentId = parentIdOf(toLoc.parent);
	if ((isContainer(dragged) || dragged.type === 'table') && parentId != null) return 'noop';

	if (where === 'before') {
		const afterId = prevSiblingId(page, toLoc);
		if (afterId === draggedId) return 'noop';
		if (alreadyThere(page, fromLoc, afterId, parentId)) return 'noop';
		return { afterId, parentId };
	}

	if (alreadyThere(page, fromLoc, targetId, parentId)) return 'noop';
	return { afterId: targetId, parentId };
}

/** Map a drop onto a target block to move-block.afterId. Top half = before target, bottom half = after. */
export function dropAfterId(
	page: KbPage,
	draggedId: string,
	targetId: string,
	where: 'before' | 'after'
): string | null | 'noop' {
	const result = dropTarget(page, draggedId, targetId, where);
	if (result === 'noop') return 'noop';
	return result.afterId;
}

export function dropWhere(clientY: number, rect: { top: number; height: number }): 'before' | 'after' {
	return clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

/**
 * Vertical origin for absolutely-positioned gutter chrome. A `display:none`
 * gutter (handles toggled off) reports a 0×0 rect, which would stack every
 * handle at the top the moment the gutter comes back — so fall back to the
 * host, which shares the same flex-row top edge.
 */
export function layoutOrigin(host: HTMLElement, gutter?: HTMLElement | null): HTMLElement {
	if (gutter && isDisplayed(gutter)) return gutter;
	return host;
}

function isDisplayed(el: HTMLElement): boolean {
	if (typeof getComputedStyle === 'function') {
		return getComputedStyle(el).display !== 'none';
	}
	return el.getClientRects().length > 0;
}

/** Gutter-column overlay boxes for nested host-direct children that share data-parent-id. */
export function overlayBoxes(host: HTMLElement, gutter?: HTMLElement | null): OverlayBox[] {
	const origin = layoutOrigin(host, gutter);
	const originTop = origin.getBoundingClientRect().top;
	const groups = new Map<string, HTMLElement[]>();
	for (const child of host.children) {
		const el = child as HTMLElement;
		if (el.getAttribute('data-block-type') === 'table_cell') continue;
		const parentId = el.getAttribute(PARENT_ID_ATTR);
		if (!parentId) continue;
		const list = groups.get(parentId);
		if (list) list.push(el);
		else groups.set(parentId, [el]);
	}
	const boxes: OverlayBox[] = [];
	for (const [parentId, els] of groups) {
		const first = els[0].getBoundingClientRect();
		const last = els[els.length - 1].getBoundingClientRect();
		boxes.push({
			parentId,
			top: first.top - originTop,
			height: Math.max(0, last.bottom - first.top)
		});
	}
	return boxes;
}

function cssEscape(value: string): string {
	if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
	return value.replace(/"/g, '\\"');
}

/** Gutter handles: visibleOrder minus cells and rows (table has a single handle; cells/rows are not draggable). */
export function gutterOrder(page: KbPage): Block[] {
	return visibleOrder(page).filter((block) => block.type !== 'table_cell' && block.type !== 'table_row');
}

/**
 * The selection a gutter-handle *click* (not drag) produces.
 *
 * Plain click toggles: clicking a handle selects its whole block; clicking the
 * same handle again collapses the selection (deselect). `anchorId` is the block
 * whose handle is currently "armed" — pass back what a previous call returned.
 * Shift-click (`extend`) stretches a contiguous range from the armed block to
 * the clicked one and leaves the armed block unchanged.
 *
 * Returns the next range plus the next `anchorId` (null once deselected), or
 * `null` when the clicked block is gone.
 */
export function gutterClickRange(
	page: KbPage,
	anchorId: string | null,
	clickedId: string,
	extend: boolean
): { range: Range; anchorId: string | null } | null {
	const block = findBlock(page, clickedId);
	if (!block) return null;
	const len = plaintextOf(block).length;

	if (extend && anchorId && anchorId !== clickedId && findBlock(page, anchorId)) {
		return {
			range: { anchor: { blockId: anchorId, offset: 0 }, head: { blockId: clickedId, offset: len } },
			anchorId
		};
	}

	if (anchorId === clickedId) {
		return { range: collapsed({ blockId: clickedId, offset: 0 }), anchorId: null };
	}

	return {
		range: { anchor: { blockId: clickedId, offset: 0 }, head: { blockId: clickedId, offset: len } },
		anchorId: clickedId
	};
}

export function handleHeights(host: HTMLElement, page?: KbPage): Record<string, number> {
	const next: Record<string, number> = {};
	for (const box of handleBoxes(host, page)) {
		next[box.id] = box.height;
	}
	return next;
}

export type HandleBox = { id: string; top: number; height: number };

/**
 * A draggable block's visual box: its own border box, except table blocks,
 * whose wrapper element collapses to zero height — the table's span is its
 * first cell's top to its last cell's bottom (same as `handleHeights` did).
 */
function blockRect(host: HTMLElement, block: Block): DOMRect | null {
	if (block.type === 'table') {
		const rows = block.children;
		if (rows.length === 0 || rows[0].children.length === 0) return null;
		const lastRow = rows[rows.length - 1];
		if (lastRow.children.length === 0) return null;
		const firstCell = rows[0].children[0];
		const lastCell = lastRow.children[lastRow.children.length - 1];
		const first = host.querySelector(`[data-block-id="${cssEscape(firstCell.id)}"]`) as HTMLElement | null;
		const last = host.querySelector(`[data-block-id="${cssEscape(lastCell.id)}"]`) as HTMLElement | null;
		if (!first || !last) return null;
		const a = first.getBoundingClientRect();
		const b = last.getBoundingClientRect();
		return {
			x: a.x,
			y: a.y,
			top: a.top,
			left: a.left,
			bottom: b.bottom,
			right: b.right,
			width: b.right - a.left,
			height: b.bottom - a.top,
			toJSON() {
				return this;
			}
		} as DOMRect;
	}
	const el = host.querySelector(`[data-block-id="${cssEscape(block.id)}"]`) as HTMLElement | null;
	if (!el) return null;
	return el.getBoundingClientRect();
}

/**
 * Absolute gutter positions, measured from the gutter's top so the handles
 * can be absolutely positioned onto their blocks. A handle spans its block's
 * own border box — margin gaps belong to no handle — so the ⋮⋮ dots sit
 * vertically centred on the content they move, on every block, however tall.
 */
export function handleBoxes(host: HTMLElement, page?: KbPage, gutter?: HTMLElement | null): HandleBox[] {
	const origin = layoutOrigin(host, gutter);
	const originTop = origin.getBoundingClientRect().top;
	const boxes: HandleBox[] = [];
	if (!page) {
		// No page envelope: measure straight off the host's rendered children.
		for (const child of host.children) {
			const el = child as HTMLElement;
			const id = el.getAttribute('data-block-id');
			if (!id || el.getAttribute('data-block-type') === 'table_cell') continue;
			const rect = el.getBoundingClientRect();
			boxes.push({ id, top: rect.top - originTop, height: Math.max(0, rect.height) });
		}
		return boxes;
	}
	for (const block of gutterOrder(page)) {
		const rect = blockRect(host, block);
		if (!rect) continue;
		boxes.push({ id: block.id, top: rect.top - originTop, height: Math.max(0, rect.height) });
	}
	return boxes;
}

export type BlockHit = { id: string; where: 'before' | 'after'; rect: DOMRect };

/**
 * Hit-test the host's rendered blocks at a client Y. Nearest block wins, so
 * the whole content column accepts a move-drop — the drag never has to land
 * on the narrow gutter — and the dragged block itself is skipped so the
 * cursor can rest on its own old position. Top half of the hit rect is
 * `before`, bottom half `after` (after a container means into it; `dropTarget`
 * owns that mapping).
 */
export function blockFromPoint(
	host: HTMLElement,
	page: KbPage,
	clientY: number,
	skipId?: string | null
): BlockHit | null {
	let best: Block | null = null;
	let bestRect: DOMRect | null = null;
	let bestDist = Infinity;
	for (const block of gutterOrder(page)) {
		if (block.id === skipId) continue;
		const rect = blockRect(host, block);
		if (!rect) continue;
		const dy = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
		if (dy < bestDist) {
			bestDist = dy;
			best = block;
			bestRect = rect;
		}
	}
	if (!best || !bestRect) return null;
	return {
		id: best.id,
		rect: bestRect,
		where: clientY < bestRect.top + bestRect.height / 2 ? 'before' : 'after'
	};
}

const DRAGGABLE = (b: Block): boolean => b.type !== 'table_cell' && b.type !== 'table_row';

/**
 * Viewport Y where the drop line paints for a hit. One line per boundary:
 * `after X` anchors to the *next sibling's* top edge — the exact position
 * `before` that sibling paints — so the same gap can never render two
 * competing lines as the cursor crosses it. A block that is its parent's
 * last child closes inside its parent (`hit.rect.bottom`), and `after` a
 * container drops into it, so the line sits inside, under the last
 * draggable child (or the container bar when it has none).
 */
export function dropLineY(
	host: HTMLElement,
	page: KbPage,
	hit: BlockHit,
	drop: DropTarget | 'noop'
): number | null {
	const rectOf = (id: string): DOMRect | null => {
		const el = host.querySelector(`[data-block-id="${cssEscape(id)}"]`) as HTMLElement | null;
		return el?.getBoundingClientRect() ?? null;
	};

	if (drop !== 'noop' && drop.parentId === hit.id) {
		const container = findBlock(page, hit.id);
		const kids = container ? childrenOf(page, container).filter(DRAGGABLE) : [];
		const last = kids.length ? rectOf(kids[kids.length - 1].id) : null;
		return (last ?? hit.rect).bottom;
	}
	const loc = parentOf(page, hit.id);
	const siblings = loc ? childrenOf(page, loc.parent) : null;
	// The line sits at the visual midpoint of the gap between the two blocks
	// sharing the boundary — blocks carry margins, so the gap is real space
	// and an edge-anchored line hugged one of them. Both readings of the same
	// gap ('after X' and 'before next') compute the identical midpoint.
	if (hit.where === 'before') {
		const prev =
			loc && siblings && loc.index > 0 ? rectOf(siblings[loc.index - 1].id) : null;
		return prev ? (prev.bottom + hit.rect.top) / 2 : hit.rect.top;
	}
	if (loc && siblings && loc.index < siblings.length - 1) {
		const next = rectOf(siblings[loc.index + 1].id);
		if (next) return (hit.rect.bottom + next.top) / 2;
	}
	return hit.rect.bottom;
}
