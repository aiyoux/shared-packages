import { describe, it, expect } from 'vitest';
import { apply, applyMany } from './apply.js';
import { invert } from './invert.js';
import { normalizeBody } from './normalize.js';
import { documentOrder, findBlock } from './tree.js';
import { plaintext } from './plaintext.js';
import type { Block, BodyOp, DocBody } from './types.js';

/**
 * A record backend has no `format`, `id`, `createdAt`, `updatedAt` or
 * child-page slug list — the graph carries all of that. These tests use a doc
 * with none of them, so a body function that quietly needed the KB envelope
 * would fail to compile or blank a field.
 */
type RecordDoc = DocBody & { pageId: string };

const span = (text: string) => [{ type: 'text' as const, text, marks: [] }];
const para = (id: string, text = 'hello'): Block => ({ id, type: 'paragraph', content: span(text) });

function recordDoc(blocks: Block[]): RecordDoc {
	return { pageId: 'records:page', title: 'Untitled', blocks };
}

describe('body functions on a doc with no KB envelope', () => {
	it('applies a body op and carries the foreign envelope through', () => {
		const doc = recordDoc([para('records:1')]);
		const op: BodyOp = { kind: 'insert-text', at: { blockId: 'records:1', offset: 0 }, text: 'X' };
		const out = apply(doc, op);
		expect(plaintext(out)).toBe('Xhello');
		// The field this package has never heard of survives untouched.
		expect(out.pageId).toBe('records:page');
		expect(Object.keys(out).sort()).toEqual(['blocks', 'pageId', 'title']);
	});

	it('applies many and inverts', () => {
		const doc = recordDoc([para('records:1')]);
		const ops: BodyOp[] = [
			{ kind: 'insert-text', at: { blockId: 'records:1', offset: 0 }, text: 'A' },
			{ kind: 'insert-block', afterId: 'records:1', block: para('records:2', 'second') }
		];
		const out = applyMany(doc, ops);
		expect(documentOrder(out).map((b) => b.id)).toEqual(['records:1', 'records:2']);

		const back = applyMany(out, invert(out, ops[1]));
		expect(documentOrder(back).map((b) => b.id)).toEqual(['records:1']);
		expect(back.pageId).toBe('records:page');
	});

	it('normalizes the body without inventing envelope fields', () => {
		const doc = recordDoc([]);
		const out = normalizeBody(doc);
		expect(out.blocks).toHaveLength(1);
		expect(out.blocks[0].type).toBe('paragraph');
		expect(out.pageId).toBe('records:page');
		expect('format' in out).toBe(false);
		expect('createdAt' in out).toBe(false);
	});

	it('reads the tree', () => {
		const doc = recordDoc([para('records:1'), para('records:2', 'two')]);
		expect(findBlock(doc, 'records:2')?.id).toBe('records:2');
		expect(plaintext(doc)).toContain('two');
	});

	it('nests containers, which the graph stores as more edges', () => {
		const doc = recordDoc([
			{
				id: 'records:callout',
				type: 'callout',
				variant: 'info',
				children: [para('records:inner', 'inside')]
			}
		]);
		const out = apply(doc, {
			kind: 'insert-text',
			at: { blockId: 'records:inner', offset: 0 },
			text: '! '
		});
		expect(plaintext(out)).toContain('! inside');
		expect(out.pageId).toBe('records:page');
	});
});
