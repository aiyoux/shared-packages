import { findBlock, parentOf, type Block, type KbPage, type Op } from '@shared-packages/kb-model';
import { newBlockId } from './ids.js';
import { defaultTable } from './table.js';

export type SlashTarget = {
	to: Block['type'];
	level?: 1 | 2 | 3;
	ordered?: boolean;
};

const SLASH: Record<string, SlashTarget> = {
	'/h1': { to: 'heading', level: 1 },
	'/h2': { to: 'heading', level: 2 },
	'/h3': { to: 'heading', level: 3 },
	'/ul': { to: 'list_item', ordered: false },
	'/ol': { to: 'list_item', ordered: true },
	'/code': { to: 'code' }
};

const WRAP: Record<string, 'callout' | 'toggle' | 'table'> = {
	'/callout': 'callout',
	'/toggle': 'toggle',
	'/table': 'table'
};

export function matchSlash(text: string): { cmd: string; target: SlashTarget } | null {
	const target = SLASH[text];
	if (!target) return null;
	return { cmd: text, target };
}

function stripCmd(blockId: string, cmd: string): Op {
	return {
		kind: 'delete-range',
		range: {
			anchor: { blockId, offset: 0 },
			head: { blockId, offset: cmd.length }
		}
	};
}

/** Insert an empty container, then move the current block into it. Not convert-block. */
function wrapOps(
	blockId: string,
	cmd: string,
	type: 'callout' | 'toggle' | 'table',
	page?: KbPage
): Op[] | null {
	if (page) {
		const loc = parentOf(page, blockId);
		if (!loc || loc.parent !== 'page') return null;
	}
	if (type === 'table') {
		return [
			{ kind: 'insert-block', afterId: blockId, block: defaultTable() },
			{ kind: 'delete-block', id: blockId }
		];
	}
	const containerId = newBlockId();
	const block: Block =
		type === 'toggle'
			? { id: containerId, type: 'toggle', open: true, children: [] }
			: { id: containerId, type: 'callout', variant: 'info', children: [] };
	return [
		{ kind: 'insert-block', afterId: blockId, block },
		{ kind: 'move-block', id: blockId, afterId: null, parentId: containerId },
		stripCmd(blockId, cmd)
	];
}

/** Convert when the caret sits at the end of a slash command that is the whole block (or prefix + space). */
export function slashOps(blockId: string, plaintext: string, page?: KbPage): Op[] | null {
	if (page && findBlock(page, blockId)?.type === 'table_cell') {
		const wrap = WRAP[plaintext];
		if (wrap) return wrapOps(blockId, plaintext, wrap, page);
		return null;
	}
	const wrap = WRAP[plaintext];
	if (wrap) return wrapOps(blockId, plaintext, wrap, page);
	const match = matchSlash(plaintext);
	if (!match) return null;
	const { cmd, target } = match;
	const convert: Op = {
		kind: 'convert-block',
		id: blockId,
		to: target.to,
		...(target.level != null ? { level: target.level } : {}),
		...(target.ordered != null ? { ordered: target.ordered } : {})
	};
	return [convert, stripCmd(blockId, cmd)];
}
