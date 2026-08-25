import { describe, expect, it } from 'vitest';
import { apply } from './apply.js';
import { normalizePage } from './normalize.js';
import { plaintext } from './plaintext.js';
import { toMarkdown } from './toMarkdown.js';
import {
	blockChildren,
	childrenOf,
	documentOrder,
	findBlock,
	parentOf,
	visibleOrder
} from './tree.js';
import { KB_FORMAT, type Block, type KbPage, type Mark, type TextSpan } from './types.js';

const STAMP = '2026-01-01T00:00:00.000Z';

function span(text: string, marks: Mark[] = []): TextSpan {
	return { type: 'text', text, marks };
}

function para(id: string, text: string): Block {
	return { id, type: 'paragraph', content: [span(text)] };
}

function callout(id: string, kids: Block[]): Block {
	return { id, type: 'callout', variant: 'info', children: kids };
}

function page(blocks: Block[]): KbPage {
	return normalizePage({
		format: KB_FORMAT,
		schemaVersion: 1,
		id: 'page-1',
		title: 'Title',
		createdAt: STAMP,
		updatedAt: STAMP,
		children: [],
		blocks
	});
}

describe('tree walk', () => {
	it('findBlock / parentOf miss unknown ids and resolve page-root vs nested', () => {
		const doc = page([para('a', 'A'), callout('c', [para('n1', 'in'), para('n2', 'two')]), para('z', 'Z')]);
		expect(findBlock(doc, 'missing')).toBeUndefined();
		expect(parentOf(doc, 'missing')).toBeUndefined();
		expect(findBlock(doc, 'a')?.id).toBe('a');
		expect(parentOf(doc, 'a')).toEqual({ parent: 'page', index: 0 });
		expect(parentOf(doc, 'c')).toEqual({ parent: 'page', index: 1 });
		expect(parentOf(doc, 'z')).toEqual({ parent: 'page', index: 2 });
		const nested = parentOf(doc, 'n1');
		expect(nested?.index).toBe(0);
		expect(nested?.parent).not.toBe('page');
		expect((nested?.parent as Block).id).toBe('c');
		expect(parentOf(doc, 'n2')?.index).toBe(1);
		expect(findBlock(doc, 'n2')?.id).toBe('n2');
	});

	it('documentOrder is DFS and visibleOrder omits closed-toggle children', () => {
		const doc = page([para('a', 'A'), callout('c', [para('n1', 'in'), para('n2', 'two')]), para('z', 'Z')]);
		expect(documentOrder(doc).map((b) => b.id)).toEqual(['a', 'c', 'n1', 'n2', 'z']);
		expect(visibleOrder(doc).map((b) => b.id)).toEqual(['a', 'c', 'n1', 'n2', 'z']);

		const hidden = para('h', 'hid');
		const toggle = {
			id: 't',
			type: 'toggle',
			open: false,
			children: [hidden]
		} as unknown as Block;
		const withToggle: KbPage = { ...doc, blocks: [...doc.blocks, toggle] };
		expect(documentOrder(withToggle).map((b) => b.id)).toContain('h');
		expect(visibleOrder(withToggle).map((b) => b.id)).not.toContain('h');
		expect(visibleOrder(withToggle).map((b) => b.id)).toContain('t');
	});

	it('childrenOf throws on a leaf and returns the live root list', () => {
		const doc = page([para('a', 'A'), callout('c', [para('n', 'in')])]);
		expect(childrenOf(doc, 'page')).toBe(doc.blocks);
		const leaf = findBlock(doc, 'a')!;
		expect(() => childrenOf(doc, leaf)).toThrow(/no children list/);
		const container = findBlock(doc, 'c')!;
		expect(childrenOf(doc, container).map((b) => b.id)).toEqual(['n']);
	});

	it('plaintext DFS uses children only for containers and tabs for table_row', () => {
		const nested = page([callout('c', [para('n1', 'in'), para('n2', 'two')]), para('z', 'Z')]);
		expect(plaintext(nested)).toBe('in\ntwo\nZ');

		const doc = page([
			{
				id: 't',
				type: 'table',
				children: [
					{
						id: 'r',
						type: 'table_row',
						children: [
							{ id: 'c1', type: 'table_cell', content: [span('a')] },
							{ id: 'c2', type: 'table_cell', content: [span('b')] }
						]
					}
				]
			}
		]);
		expect(plaintext(doc)).toBe('a\tb');
		expect(documentOrder(doc).map((b) => b.id)).toEqual(['t', 'r', 'c1', 'c2']);
	});

	it('toMarkdown walks DFS including nested children', () => {
		const doc = page([callout('c', [para('n', 'inside')]), para('z', 'Z')]);
		expect(toMarkdown(doc)).toBe('> inside\n\nZ\n');
		expect(toMarkdown(page([callout('c', [para('n', 'inside')]), para('z', 'Z')]))).toBe('> inside\n\nZ\n');
	});
});

describe('apply uses parent lists', () => {
	it('split-block inserts the new id as the next sibling in the parent, not the page root', () => {
		const src = page([callout('c', [para('a', 'ab'), para('b', 'cd')]), para('z', 'z')]);
		const next = apply(src, { kind: 'split-block', at: { blockId: 'a', offset: 1 }, newId: 'n' });
		expect(next.blocks.map((b) => b.id)).toEqual(['c', 'z']);
		expect(blockChildren(findBlock(next, 'c')!)?.map((b) => b.id)).toEqual(['a', 'n', 'b']);
		expect((findBlock(next, 'a') as { content: TextSpan[] }).content[0].text).toBe('a');
		expect((findBlock(next, 'n') as { content: TextSpan[] }).content[0].text).toBe('b');
	});

	it('merge-block requires same-parent immediate siblings', () => {
		const src = page([
			callout('c', [para('a', 'he'), para('b', 'llo')]),
			para('z', '!')
		]);
		const merged = apply(src, { kind: 'merge-block', keepId: 'a', dropId: 'b' });
		expect(blockChildren(findBlock(merged, 'c')!)?.map((b) => b.id)).toEqual(['a']);
		expect((findBlock(merged, 'a') as { content: TextSpan[] }).content[0].text).toBe('hello');

		expect(() => apply(src, { kind: 'merge-block', keepId: 'a', dropId: 'z' })).toThrow(
			/immediate next/i
		);
		expect(() => apply(src, { kind: 'merge-block', keepId: 'missing', dropId: 'b' })).toThrow(
			/unknown/i
		);
	});

	it('delete-range from inside a callout to after does not concat across the boundary', () => {
		const src = page([callout('c', [para('a', 'aa'), para('b', 'bb')]), para('z', 'zz')]);
		const crossed = apply(src, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'a', offset: 1 }, head: { blockId: 'z', offset: 1 } }
		});
		expect(crossed.blocks.map((b) => b.id)).toEqual(['c', 'z']);
		expect(blockChildren(findBlock(crossed, 'c')!)?.map((b) => b.id)).toEqual(['a']);
		expect((findBlock(crossed, 'a') as { content: TextSpan[] }).content[0].text).toBe('a');
		expect((findBlock(crossed, 'z') as { content: TextSpan[] }).content[0].text).toBe('z');

		const joined = apply(src, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'a', offset: 1 }, head: { blockId: 'b', offset: 1 } }
		});
		expect(blockChildren(findBlock(joined, 'c')!)?.map((b) => b.id)).toEqual(['a']);
		expect((findBlock(joined, 'a') as { content: TextSpan[] }).content[0].text).toBe('ab');
	});

	it('insert-block duplicate id is tree-wide and parentId is required for nested afterId', () => {
		const src = page([callout('c', [para('a', 'x')]), para('z', 'z')]);
		expect(() =>
			apply(src, { kind: 'insert-block', afterId: 'z', block: para('a', 'dup') })
		).toThrow(/duplicate/i);
		expect(() =>
			apply(src, { kind: 'split-block', at: { blockId: 'a', offset: 0 }, newId: 'z' })
		).toThrow(/already exists/i);
		expect(() =>
			apply(src, { kind: 'insert-block', afterId: 'missing', block: para('n', 'n') })
		).toThrow(/unknown/i);
		expect(() =>
			apply(src, {
				kind: 'insert-block',
				afterId: 'z',
				block: callout('n', [para('z', 'dup')])
			})
		).toThrow(/duplicate/i);
		expect(() =>
			apply(src, {
				kind: 'insert-block',
				afterId: 'z',
				block: callout('n', [para('n', 'self')])
			})
		).toThrow(/duplicate/i);
		expect(() => apply(src, { kind: 'insert-block', afterId: 'a', block: para('n', 'n') })).toThrow(
			/not a child of the page/i
		);

		const inserted = apply(src, {
			kind: 'insert-block',
			afterId: 'a',
			parentId: 'c',
			block: para('n', 'n')
		});
		expect(inserted.blocks.map((b) => b.id)).toEqual(['c', 'z']);
		expect(blockChildren(findBlock(inserted, 'c')!)?.map((b) => b.id)).toEqual(['a', 'n']);
	});

	it('move-block into a callout needs parentId; afterId null prepends at page root', () => {
		const src = page([callout('c', [para('a', 'a'), para('b', 'b')]), para('z', 'z')]);
		expect(() => apply(src, { kind: 'move-block', id: 'a', afterId: 'b' })).toThrow(
			/not a child of the page/i
		);
		const nested = apply(src, { kind: 'move-block', id: 'a', afterId: 'b', parentId: 'c' });
		expect(blockChildren(findBlock(nested, 'c')!)?.map((b) => b.id)).toEqual(['b', 'a']);
		const lifted = apply(src, { kind: 'move-block', id: 'b', afterId: null });
		expect(lifted.blocks.map((b) => b.id)).toEqual(['b', 'c', 'z']);
		expect(blockChildren(findBlock(lifted, 'c')!)?.map((b) => b.id)).toEqual(['a']);
		expect(() => apply(src, { kind: 'move-block', id: 'a', afterId: 'missing' })).toThrow(/unknown/i);
	});
});
