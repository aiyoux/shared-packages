import { describe, expect, it } from 'vitest';
import { createEditorState } from './state.js';
import { pasteOps, serializeSlice } from './clipboard.js';
import { page, para, span } from './testFixtures.js';
import type { Mark } from '@shared-packages/doc-model';

const review: Mark = {
	type: 'review',
	id: 'r-old',
	style: 'marker',
	color: 'yellow',
	note: 'Check'
};

function reviewId(marks: Mark[] | undefined): string | undefined {
	const hit = marks?.find((mark) => mark.type === 'review');
	return hit?.type === 'review' ? hit.id : undefined;
}

describe('pasteOps review marks', () => {
	it('keeps the colour, style, and note, and mints a new id', () => {
		const src = page([
			{
				id: 'a',
				type: 'paragraph',
				content: [span('Hello', [review])]
			}
		]);
		const dest = createEditorState(page([para('p', '')]));
		const live = { anchor: { blockId: 'p', offset: 0 }, head: { blockId: 'p', offset: 0 } };
		const ops = pasteOps(dest, live, { json: serializeSlice(src.blocks) });
		const inserted = ops.find((op) => op.kind === 'insert-block');
		expect(inserted?.kind).toBe('insert-block');
		if (inserted?.kind !== 'insert-block' || inserted.block.type !== 'paragraph') return;
		const marks = inserted.block.content[0]?.marks;
		const next = marks?.find((mark) => mark.type === 'review');
		expect(next).toMatchObject({ type: 'review', style: 'marker', color: 'yellow', note: 'Check' });
		expect(reviewId(marks)).not.toBe('r-old');
	});
});
