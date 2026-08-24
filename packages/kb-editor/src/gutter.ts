import type { KbPage } from '@shared-packages/kb-model';
import { blockIndex } from './range.js';

export type DropPosition = {
	id: string;
	afterId: string | null;
};

/** Map a drop onto a target block to move-block.afterId. Top half = before target, bottom half = after. */
export function dropAfterId(page: KbPage, draggedId: string, targetId: string, where: 'before' | 'after'): string | null | 'noop' {
	if (draggedId === targetId) return 'noop';
	const from = blockIndex(page, draggedId);
	const to = blockIndex(page, targetId);
	if (from < 0 || to < 0) return 'noop';
	if (where === 'before') {
		const afterId = to === 0 ? null : page.blocks[to - 1].id;
		if (afterId === draggedId) return 'noop';
		const currentPrev = from === 0 ? null : page.blocks[from - 1].id;
		if (afterId === currentPrev) return 'noop';
		return afterId;
	}
	if (targetId === draggedId) return 'noop';
	const currentPrev = from === 0 ? null : page.blocks[from - 1].id;
	if (targetId === currentPrev) return 'noop';
	return targetId;
}

export function dropWhere(clientY: number, rect: { top: number; height: number }): 'before' | 'after' {
	return clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}
