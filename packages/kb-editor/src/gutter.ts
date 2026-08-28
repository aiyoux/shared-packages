import {
	childrenOf,
	findBlock,
	isContainer,
	isDescendant,
	isTableStructure,
	parentIdOf,
	parentOf,
	visibleOrder,
	type Block,
	type KbPage
} from '@shared-packages/kb-model';
import { PARENT_ID_ATTR } from './project.js';

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

/** Gutter-column overlay boxes for nested host-direct children that share data-parent-id. */
export function overlayBoxes(host: HTMLElement, gutter?: HTMLElement | null): OverlayBox[] {
	const origin = gutter ?? host;
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

export function handleHeights(host: HTMLElement, page?: KbPage): Record<string, number> {
	const next: Record<string, number> = {};
	for (const child of host.children) {
		const el = child as HTMLElement;
		const id = el.getAttribute('data-block-id');
		if (id) next[id] = el.offsetHeight;
	}
	if (!page) return next;
	for (const block of visibleOrder(page)) {
		if (block.type === 'table') {
			const rows = block.children;
			if (rows.length === 0) continue;
			const firstRow = rows[0];
			const lastRow = rows[rows.length - 1];
			if (firstRow.children.length === 0 || lastRow.children.length === 0) continue;
			const firstCell = firstRow.children[0];
			const lastCell = lastRow.children[lastRow.children.length - 1];
			const first = host.querySelector(`[data-block-id="${cssEscape(firstCell.id)}"]`) as HTMLElement | null;
			const last = host.querySelector(`[data-block-id="${cssEscape(lastCell.id)}"]`) as HTMLElement | null;
			if (!first || !last) continue;
			next[block.id] = Math.max(0, last.getBoundingClientRect().bottom - first.getBoundingClientRect().top);
		} else if (block.type === 'table_row') {
			const cells = block.children;
			if (cells.length === 0) continue;
			const first = host.querySelector(`[data-block-id="${cssEscape(cells[0].id)}"]`) as HTMLElement | null;
			const last = host.querySelector(
				`[data-block-id="${cssEscape(cells[cells.length - 1].id)}"]`
			) as HTMLElement | null;
			if (!first || !last) continue;
			next[block.id] = Math.max(0, last.getBoundingClientRect().bottom - first.getBoundingClientRect().top);
		}
	}
	return next;
}
