import type { Block, Op } from '@shared-packages/kb-model';

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

export function matchSlash(text: string): { cmd: string; target: SlashTarget } | null {
	const target = SLASH[text];
	if (!target) return null;
	return { cmd: text, target };
}

/** Convert when the caret sits at the end of a slash command that is the whole block (or prefix + space). */
export function slashOps(blockId: string, plaintext: string): Op[] | null {
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
	const strip: Op = {
		kind: 'delete-range',
		range: {
			anchor: { blockId, offset: 0 },
			head: { blockId, offset: cmd.length }
		}
	};
	return [convert, strip];
}
