import {
	childrenOf,
	findBlock,
	isContainer,
	isDescendant,
	parentIdOf,
	parentOf,
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

	if (isContainer(target) && where === 'after') {
		if (isContainer(dragged)) return 'noop';
		if (fromLoc.parent !== 'page' && fromLoc.parent.id === target.id && fromLoc.index === 0) {
			return 'noop';
		}
		return { afterId: null, parentId: target.id };
	}

	const parentId = parentIdOf(toLoc.parent);
	if (isContainer(dragged) && parentId != null) return 'noop';

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

export function handleHeights(host: HTMLElement): Record<string, number> {
	const next: Record<string, number> = {};
	for (const child of host.children) {
		const el = child as HTMLElement;
		const id = el.getAttribute('data-block-id');
		if (id) next[id] = el.offsetHeight;
	}
	return next;
}
