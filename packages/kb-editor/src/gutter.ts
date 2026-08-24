import { childrenOf, parentOf, type KbPage } from '@shared-packages/kb-model';

export type DropPosition = {
	id: string;
	afterId: string | null;
};

/** Map a drop onto a target block to move-block.afterId. Top half = before target, bottom half = after. */
export function dropAfterId(page: KbPage, draggedId: string, targetId: string, where: 'before' | 'after'): string | null | 'noop' {
	if (draggedId === targetId) return 'noop';
	const fromLoc = parentOf(page, draggedId);
	const toLoc = parentOf(page, targetId);
	if (!fromLoc || !toLoc) return 'noop';
	const siblings = childrenOf(page, toLoc.parent);
	if (where === 'before') {
		const afterId = toLoc.index === 0 ? null : siblings[toLoc.index - 1].id;
		if (afterId === draggedId) return 'noop';
		const currentPrev = fromLoc.index === 0 ? null : childrenOf(page, fromLoc.parent)[fromLoc.index - 1].id;
		if (afterId === currentPrev) return 'noop';
		return afterId;
	}
	if (targetId === draggedId) return 'noop';
	const currentPrev = fromLoc.index === 0 ? null : childrenOf(page, fromLoc.parent)[fromLoc.index - 1].id;
	if (targetId === currentPrev) return 'noop';
	return targetId;
}

export function dropWhere(clientY: number, rect: { top: number; height: number }): 'before' | 'after' {
	return clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}
