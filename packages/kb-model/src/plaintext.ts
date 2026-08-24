import { blockChildren } from './tree.js';
import type { Block, KbPage, TextLikeBlock } from './types.js';

export function isTextLike(block: Block): block is TextLikeBlock {
	return block.type === 'paragraph' || block.type === 'heading' || block.type === 'list_item';
}

export function isAtomic(block: Block): block is Extract<Block, { type: 'divider' | 'image' }> {
	return block.type === 'divider' || block.type === 'image';
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
