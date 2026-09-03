import { blockChildren } from './tree.js';
import type {
	Block,
	ContainerBlock,
	KbPage,
	TableStructureBlock,
	TextLikeBlock
} from './types.js';

export function isTextLike(block: Block): block is TextLikeBlock {
	return (
		block.type === 'paragraph' ||
		block.type === 'heading' ||
		block.type === 'list_item' ||
		block.type === 'table_cell'
	);
}

export function isAtomic(block: Block): block is Extract<Block, { type: 'divider' | 'image' }> {
	return block.type === 'divider' || block.type === 'image';
}

export function isContainer(block: Block): block is ContainerBlock {
	return block.type === 'callout' || block.type === 'toggle';
}

export function isTableStructure(block: Block): block is TableStructureBlock {
	return block.type === 'table' || block.type === 'table_row';
}

const KNOWN_BLOCK_TYPES: ReadonlySet<string> = new Set([
	'paragraph',
	'heading',
	'list_item',
	'code',
	'divider',
	'image',
	'callout',
	'toggle',
	'table',
	'table_row',
	'table_cell'
]);

/** A block type this build does not model — preserved opaquely, never edited in place. */
export function isUnknownBlock(block: Block): boolean {
	return !KNOWN_BLOCK_TYPES.has((block as { type: string }).type);
}

/** Caret targets that only allow offset 0 (blockFocus). */
export function isNonTextual(block: Block): boolean {
	return isAtomic(block) || isContainer(block) || isTableStructure(block) || isUnknownBlock(block);
}

export function plaintextOf(block: Block): string {
	if (isTextLike(block)) return block.content.map((span) => span.text).join('');
	if (block.type === 'code') return block.text;
	return '';
}

function plaintextTree(block: Block): string {
	const kids = blockChildren(block);
	if (!kids || kids.length === 0) return plaintextOf(block);
	const type = (block as { type: string }).type;
	if (type === 'table_row') return kids.map(plaintextTree).join('\t');
	return kids.map(plaintextTree).join('\n');
}

/** Concatenated plaintext of every block. Code keeps interior `\n`; blocks are joined with `\n`. */
export function plaintext(page: KbPage): string {
	return (page.blocks ?? []).map(plaintextTree).join('\n');
}

export function payloadLength(block: Block): number {
	return plaintextOf(block).length;
}
