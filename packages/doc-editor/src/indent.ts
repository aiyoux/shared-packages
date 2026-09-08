import {
	canTakeIndent,
	documentOrder,
	findBlock,
	MAX_INDENT,
	plaintextOf,
	type Block,
	type KbPage,
	type Op,
	type Range
} from '@shared-packages/doc-model';
import { collapsed, isCollapsed, orderedRange } from './range.js';

function blocksInSelection(page: KbPage, range: Range): Block[] {
	const { start, end } = orderedRange(page, range);
	const order = documentOrder(page);
	const si = order.findIndex((b) => b.id === start.blockId);
	const ei = order.findIndex((b) => b.id === end.blockId);
	if (si < 0) return [];
	return order.slice(si, (ei < 0 ? si : ei) + 1);
}

/** Tab / Shift+Tab on a code fence inserts or removes a tab at the caret. */
export function codeTabOps(
	page: KbPage,
	live: Range,
	shift: boolean
): { ops: Op[]; selection?: Range } | null {
	if (!isCollapsed(live)) return null;
	const block = findBlock(page, live.anchor.blockId);
	if (block?.type !== 'code') return null;
	const at = live.anchor;
	if (!shift) {
		return {
			ops: [{ kind: 'insert-text', at, text: '\t' }],
			selection: collapsed({ blockId: at.blockId, offset: at.offset + 1 })
		};
	}
	const text = plaintextOf(block);
	if (at.offset <= 0) return { ops: [] };
	if (text[at.offset - 1] === '\t') {
		const range = {
			anchor: { blockId: at.blockId, offset: at.offset - 1 },
			head: at
		};
		return {
			ops: [{ kind: 'delete-range', range }],
			selection: collapsed({ blockId: at.blockId, offset: at.offset - 1 })
		};
	}
	if (text[at.offset - 1] === ' ') {
		let from = at.offset - 1;
		let n = 1;
		while (from > 0 && text[from - 1] === ' ' && n < 2) {
			from--;
			n++;
		}
		const range = { anchor: { blockId: at.blockId, offset: from }, head: at };
		return {
			ops: [{ kind: 'delete-range', range }],
			selection: collapsed({ blockId: at.blockId, offset: from })
		};
	}
	return { ops: [] };
}

/** Indent or outdent every indentable block in the selection. */
export function indentOps(page: KbPage, live: Range, delta: 1 | -1): { ops: Op[] } {
	const ops: Op[] = [];
	for (const block of blocksInSelection(page, live)) {
		if (!canTakeIndent(block)) continue;
		const cur = block.indent ?? 0;
		const next = Math.max(0, Math.min(MAX_INDENT, cur + delta));
		if (next === cur) continue;
		ops.push({ kind: 'set-indent', id: block.id, indent: next === 0 ? null : next });
	}
	return { ops };
}
