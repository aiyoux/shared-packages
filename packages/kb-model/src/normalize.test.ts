import { describe, expect, it } from 'vitest';
import { createEmptyPage } from './createEmptyPage.js';
import { normalizePage, normalizeSpans } from './normalize.js';
import { KB_FORMAT, type KbPage, type Mark, type TextSpan } from './types.js';

function span(text: string, marks: Mark[] = []): TextSpan {
	return { type: 'text', text, marks };
}

describe('normalizeSpans', () => {
	it('drops empty spans except a single empty span', () => {
		expect(normalizeSpans([])).toEqual([span('')]);
		expect(normalizeSpans([span(''), span('')])).toEqual([span('')]);
		expect(normalizeSpans([span(''), span('ab')])).toEqual([span('ab')]);
	});

	it('merges adjacent spans with equal marks', () => {
		expect(normalizeSpans([span('a', [{ type: 'bold' }]), span('b', [{ type: 'bold' }])])).toEqual([
			span('ab', [{ type: 'bold' }])
		]);
		expect(
			normalizeSpans([span('a', [{ type: 'bold' }]), span('b', [{ type: 'italic' }])])
		).toHaveLength(2);
	});

	it('sorts marks bold, italic, code, link and last link href wins', () => {
		const marks: Mark[] = [
			{ type: 'link', href: 'https://a.example' },
			{ type: 'code' },
			{ type: 'bold' },
			{ type: 'italic' },
			{ type: 'link', href: 'https://b.example' }
		];
		expect(normalizeSpans([span('x', marks)])[0].marks).toEqual([
			{ type: 'bold' },
			{ type: 'italic' },
			{ type: 'code' },
			{ type: 'link', href: 'https://b.example' }
		]);
	});

	it('strips newlines from text spans', () => {
		expect(normalizeSpans([span('a\nb')])).toEqual([span('ab')]);
	});
});

describe('normalizePage', () => {
	it('keeps blocks.length >= 1 by inserting an empty paragraph', () => {
		const page = createEmptyPage({ id: 'p', title: 't' });
		const emptied = normalizePage({ ...page, blocks: [] });
		expect(emptied.blocks).toHaveLength(1);
		expect(emptied.blocks[0].type).toBe('paragraph');
		expect(emptied.blocks[0].id).not.toBe('');
		if (emptied.blocks[0].type === 'paragraph') {
			expect(emptied.blocks[0].content).toEqual([span('')]);
		}
	});

	it('converts unknown block types to a plaintext paragraph', () => {
		const page = {
			format: KB_FORMAT,
			schemaVersion: 1,
			id: 'p',
			title: 't',
			createdAt: '',
			updatedAt: '',
			children: [],
			blocks: [{ id: 'x', type: 'toggle', text: 'Hidden' }]
		} as unknown as KbPage;
		const normalized = normalizePage(page);
		expect(normalized.blocks[0]).toEqual({
			id: 'x',
			type: 'paragraph',
			content: [span('Hidden')]
		});
	});

	it('preserves nested children on a known block through orderedBlock', () => {
		const page = {
			format: KB_FORMAT,
			schemaVersion: 1,
			id: 'p',
			title: 't',
			createdAt: '',
			updatedAt: '',
			children: [],
			blocks: [
				{
					id: 'c',
					type: 'paragraph',
					content: [span('')],
					children: [{ id: 'n', type: 'paragraph', content: [span('in')] }]
				}
			]
		} as unknown as KbPage;
		const normalized = normalizePage(page);
		expect(normalized.blocks[0].id).toBe('c');
		expect((normalized.blocks[0] as { children?: { id: string }[] }).children?.[0]).toEqual({
			id: 'n',
			type: 'paragraph',
			content: [span('in')]
		});
	});

	it('does not regenerate existing block ids', () => {
		const page = createEmptyPage({ id: 'p', title: 't' });
		const id = page.blocks[0].id;
		expect(normalizePage(page).blocks[0].id).toBe(id);
		expect(normalizePage(normalizePage(page)).blocks[0].id).toBe(id);
	});
});
