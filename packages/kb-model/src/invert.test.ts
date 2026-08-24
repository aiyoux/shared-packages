import { describe, expect, it } from 'vitest';
import { apply, applyMany } from './apply.js';
import { invert } from './invert.js';
import { normalizePage } from './normalize.js';
import { plaintextOf } from './plaintext.js';
import {
	KB_FORMAT,
	type Block,
	type KbPage,
	type Mark,
	type Op,
	type TextSpan
} from './types.js';

const STAMP = '2026-01-01T00:00:00.000Z';

function span(text: string, marks: Mark[] = []): TextSpan {
	return { type: 'text', text, marks };
}

function page(blocks: Block[], extra: Partial<KbPage> = {}): KbPage {
	return normalizePage({
		format: KB_FORMAT,
		schemaVersion: 1,
		id: 'page-1',
		title: 'Title',
		createdAt: STAMP,
		updatedAt: STAMP,
		children: ['child'],
		blocks,
		...extra
	});
}

function para(id: string, text: string, marks: Mark[] = []): Block {
	return { id, type: 'paragraph', content: [span(text, marks)] };
}

function heading(id: string, text: string, level: 1 | 2 | 3 = 1): Block {
	return { id, type: 'heading', level, content: [span(text)] };
}

function item(id: string, text: string, ordered = false): Block {
	return { id, type: 'list_item', ordered, content: [span(text)] };
}

function code(id: string, text: string, language = ''): Block {
	return { id, type: 'code', language, text };
}

function comparable(doc: KbPage) {
	const normalized = normalizePage(doc);
	return { ...normalized, updatedAt: '' };
}

function expectInvert(doc: KbPage, op: Op): KbPage {
	const pre = normalizePage(doc);
	const inverse = invert(pre, op);
	const post = apply(pre, op);
	const restored = applyMany(post, inverse);
	expect(comparable(restored)).toEqual(comparable(pre));
	return restored;
}

describe('invert golden applyMany(apply(page, op), invert(page, op)) === normalizePage(page)', () => {
	it('round-trips insert-text (including empty no-op)', () => {
		const src = page([para('p', 'ab', [{ type: 'bold' }])]);
		expectInvert(src, { kind: 'insert-text', at: { blockId: 'p', offset: 1 }, text: 'X' });
		expectInvert(src, { kind: 'insert-text', at: { blockId: 'p', offset: 0 }, text: '' });
		expectInvert(page([code('c', 'ab')]), {
			kind: 'insert-text',
			at: { blockId: 'c', offset: 1 },
			text: '\n'
		});
		expectInvert(page([para('p', 'x'), { id: 'd', type: 'divider' }]), {
			kind: 'insert-text',
			at: { blockId: 'd', offset: 0 },
			text: ''
		});
	});

	it('throws on empty insert-text at an unresolved Point', () => {
		const src = page([para('p', 'ab'), { id: 'd', type: 'divider' }]);
		expect(() =>
			invert(src, { kind: 'insert-text', at: { blockId: 'missing', offset: 0 }, text: '' })
		).toThrow(/unresolved Point/i);
		expect(() =>
			invert(src, { kind: 'insert-text', at: { blockId: 'p', offset: 3 }, text: '' })
		).toThrow(/unresolved Point/i);
		expect(() =>
			invert(src, { kind: 'insert-text', at: { blockId: 'd', offset: 1 }, text: '' })
		).toThrow(/unresolved Point/i);
	});

	it('round-trips same-block delete-range including emoji and marks', () => {
		const src = page([para('p', 'a👍b')]);
		expectInvert(src, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 3 } }
		});
		expectInvert(src, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'p', offset: 2 }, head: { blockId: 'p', offset: 2 } }
		});
		const marked = page([
			{
				id: 'p',
				type: 'paragraph',
				content: [span('hello', [{ type: 'bold' }]), span(' world')]
			}
		]);
		expectInvert(marked, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'p', offset: 3 }, head: { blockId: 'p', offset: 8 } }
		});
		expectInvert(page([code('c', 'ab\ncd')]), {
			kind: 'delete-range',
			range: { anchor: { blockId: 'c', offset: 1 }, head: { blockId: 'c', offset: 4 } }
		});
	});

	it('round-trips cross-block delete-range without a sentinel UUID', () => {
		const src = page([para('a', 'hello'), para('b', 'world')]);
		const op: Op = {
			kind: 'delete-range',
			range: { anchor: { blockId: 'a', offset: 3 }, head: { blockId: 'b', offset: 2 } }
		};
		const restored = expectInvert(src, op);
		expect(restored.blocks.map((b) => b.id)).toEqual(['a', 'b']);

		const withMiddle = page([para('a', 'aa'), { id: 'd', type: 'divider' }, para('c', 'cc')]);
		expectInvert(withMiddle, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'a', offset: 1 }, head: { blockId: 'c', offset: 1 } }
		});

		expectInvert(page([para('p', 'ab'), code('c', 'c\nd')]), {
			kind: 'delete-range',
			range: { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'c', offset: 1 } }
		});
		expectInvert(page([code('c', 'ab\n'), para('p', 'cd')]), {
			kind: 'delete-range',
			range: { anchor: { blockId: 'c', offset: 1 }, head: { blockId: 'p', offset: 1 } }
		});
		expectInvert(page([{ id: 'd', type: 'divider' }, para('p', 'hi')]), {
			kind: 'delete-range',
			range: { anchor: { blockId: 'd', offset: 0 }, head: { blockId: 'p', offset: 0 } }
		});
	});

	it('round-trips format-range including cross-block and link href capture', () => {
		const src = page([para('a', 'hello'), para('b', 'world')]);
		expectInvert(src, {
			kind: 'format-range',
			range: { anchor: { blockId: 'a', offset: 3 }, head: { blockId: 'b', offset: 2 } },
			mark: { type: 'bold' },
			on: true
		});
		const linked = apply(src, {
			kind: 'format-range',
			range: { anchor: { blockId: 'a', offset: 0 }, head: { blockId: 'a', offset: 5 } },
			mark: { type: 'link', href: 'https://example.com' },
			on: true
		});
		expectInvert(linked, {
			kind: 'format-range',
			range: { anchor: { blockId: 'a', offset: 0 }, head: { blockId: 'a', offset: 5 } },
			mark: { type: 'link', href: 'https://example.com' },
			on: false
		});
	});

	it('round-trips split-block; code empty-last-line restores the trailing newline', () => {
		expectInvert(page([para('p', 'abcd')]), {
			kind: 'split-block',
			at: { blockId: 'p', offset: 2 },
			newId: 'n'
		});
		expectInvert(page([heading('h', 'Hello', 2)]), {
			kind: 'split-block',
			at: { blockId: 'h', offset: 2 },
			newId: 'n'
		});
		expectInvert(page([item('l', 'ab', true)]), {
			kind: 'split-block',
			at: { blockId: 'l', offset: 1 },
			newId: 'n'
		});
		expectInvert(page([code('c', 'hi\n')]), {
			kind: 'split-block',
			at: { blockId: 'c', offset: 3 },
			newId: 'n'
		});
		expectInvert(page([code('c', '')]), {
			kind: 'split-block',
			at: { blockId: 'c', offset: 0 },
			newId: 'n'
		});
	});

	it('round-trips merge of a two-block page without injecting a sentinel UUID', () => {
		const src = page([para('a', 'hello'), para('b', 'world')]);
		const op: Op = { kind: 'merge-block', keepId: 'a', dropId: 'b' };
		const post = apply(src, op);
		expect(post.blocks.map((b) => b.id)).toEqual(['a']);
		const restored = expectInvert(src, op);
		expect(restored.blocks.map((b) => b.id)).toEqual(['a', 'b']);
		expect(plaintextOf(restored.blocks[0])).toBe('hello');
		expect(plaintextOf(restored.blocks[1])).toBe('world');

		expectInvert(page([heading('a', 'He', 2), heading('b', 'llo', 2)]), {
			kind: 'merge-block',
			keepId: 'a',
			dropId: 'b'
		});
		expectInvert(page([heading('a', 'He', 1), heading('b', 'llo', 2)]), {
			kind: 'merge-block',
			keepId: 'a',
			dropId: 'b'
		});
		expectInvert(page([para('a', 'pre'), code('b', 'x\ny', 'ts')]), {
			kind: 'merge-block',
			keepId: 'a',
			dropId: 'b'
		});
		expectInvert(page([code('a', 'pre', 'js'), para('b', 'post')]), {
			kind: 'merge-block',
			keepId: 'a',
			dropId: 'b'
		});
		expectInvert(page([code('a', 'aa'), code('b', 'bb')]), {
			kind: 'merge-block',
			keepId: 'a',
			dropId: 'b'
		});
		expectInvert(page([para('a', 'x'), { id: 'd', type: 'divider' }]), {
			kind: 'merge-block',
			keepId: 'a',
			dropId: 'd'
		});
		expectInvert(page([item('a', 'a', false), item('b', 'b', true)]), {
			kind: 'merge-block',
			keepId: 'a',
			dropId: 'b'
		});
	});

	it('round-trips insert-block, delete-block, move-block, set-title, set-code, set-children', () => {
		const src = page([para('a', 'a'), para('b', 'b')]);
		expectInvert(src, { kind: 'insert-block', afterId: 'a', block: para('n', 'n') });
		expectInvert(src, { kind: 'insert-block', afterId: null, block: { id: 'd', type: 'divider' } });
		expectInvert(src, { kind: 'delete-block', id: 'b' });
		expectInvert(src, { kind: 'move-block', id: 'b', afterId: null });
		expectInvert(src, { kind: 'move-block', id: 'a', afterId: 'b' });
		expectInvert(src, { kind: 'set-title', title: 'Other' });
		expectInvert(page([code('c', 'x', 'js'), para('p', 'p')]), {
			kind: 'set-code',
			id: 'c',
			language: 'ts'
		});
		expectInvert(src, { kind: 'set-children', children: ['z', 'y'] });
	});

	it('round-trips convert-block; sole block keeps Block.id', () => {
		const sole = page([para('only', 'Hello', [{ type: 'bold' }])]);
		const toHeading = apply(sole, { kind: 'convert-block', id: 'only', to: 'heading', level: 2 });
		expect(toHeading.blocks[0].id).toBe('only');
		expectInvert(sole, { kind: 'convert-block', id: 'only', to: 'heading', level: 2 });
		expectInvert(sole, { kind: 'convert-block', id: 'only', to: 'list_item', ordered: true });
		expectInvert(sole, { kind: 'convert-block', id: 'only', to: 'code' });
		expectInvert(sole, { kind: 'convert-block', id: 'only', to: 'divider' });
		expectInvert(page([code('only', 'a\nb', 'ts')]), {
			kind: 'convert-block',
			id: 'only',
			to: 'paragraph'
		});

		const two = page([para('a', 'aa'), para('b', 'bb')]);
		expectInvert(two, { kind: 'convert-block', id: 'a', to: 'heading' });
		expectInvert(two, { kind: 'convert-block', id: 'a', to: 'code' });
		expectInvert(two, { kind: 'convert-block', id: 'a', to: 'divider' });
		expectInvert(page([para('a', 'x'), { id: 'd', type: 'divider' }]), {
			kind: 'convert-block',
			id: 'd',
			to: 'paragraph'
		});
	});

	it('applies invert to apply(page, op), not to the pre-state', () => {
		const src = page([para('p', 'ab')]);
		const op: Op = { kind: 'insert-text', at: { blockId: 'p', offset: 0 }, text: 'X' };
		const inverse = invert(src, op);
		const wrong = applyMany(src, inverse);
		expect(plaintextOf(wrong.blocks[0])).toBe('b');
		const right = applyMany(apply(src, op), inverse);
		expect(plaintextOf(right.blocks[0])).toBe('ab');
	});

	it('round-trips nested same-parent split/merge/delete and DFS cross-parent delete-range', () => {
		function callout(id: string, kids: Block[]): Block {
			return { id, type: 'callout', variant: 'info', children: kids };
		}
		const src = page([callout('c', [para('a', 'ab'), para('b', 'cd')]), para('z', 'z')]);
		expectInvert(src, { kind: 'split-block', at: { blockId: 'a', offset: 1 }, newId: 'n' });
		expectInvert(src, { kind: 'merge-block', keepId: 'a', dropId: 'b' });
		expectInvert(src, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'a', offset: 1 }, head: { blockId: 'b', offset: 1 } }
		});
		expectInvert(src, {
			kind: 'insert-block',
			afterId: 'a',
			parentId: 'c',
			block: para('n', 'n')
		});
		expectInvert(src, { kind: 'delete-block', id: 'b' });
		expectInvert(src, { kind: 'move-block', id: 'b', afterId: 'z' });
		expectInvert(src, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'a', offset: 0 }, head: { blockId: 'z', offset: 1 } }
		});
		expect(() => invert(src, { kind: 'merge-block', keepId: 'a', dropId: 'z' })).toThrow(
			/immediate next/i
		);
		expect(() => invert(src, { kind: 'delete-block', id: 'missing' })).toThrow(/unknown/i);
	});

	it('parentId on invert restores a nested first-child delete/move', () => {
		function callout(id: string, kids: Block[]): Block {
			return { id, type: 'callout', variant: 'info', children: kids };
		}
		const src = page([callout('c', [para('a', 'a'), para('b', 'b')]), para('z', 'z')]);

		const deleteOp: Op = { kind: 'delete-block', id: 'a' };
		expect(invert(src, deleteOp)).toEqual([
			{ kind: 'insert-block', afterId: null, parentId: 'c', block: para('a', 'a') }
		]);
		expectInvert(src, deleteOp);
		expectInvert(page([callout('c', [para('a', 'a'), para('b', 'b')])]), {
			kind: 'delete-block',
			id: 'a'
		});

		const moveOp: Op = { kind: 'move-block', id: 'a', afterId: 'b', parentId: 'c' };
		expect(invert(src, moveOp)).toEqual([
			{ kind: 'move-block', id: 'a', afterId: null, parentId: 'c' }
		]);
		expectInvert(src, moveOp);
	});

	it('round-trips move into/out of a callout and covering delete-range', () => {
		function callout(id: string, kids: Block[]): Block {
			return { id, type: 'callout', variant: 'info', children: kids };
		}
		const src = page([callout('c', [para('a', 'aa'), para('b', 'bb')]), para('z', 'zz')]);
		expectInvert(src, { kind: 'move-block', id: 'z', afterId: 'a', parentId: 'c' });
		expectInvert(src, { kind: 'move-block', id: 'b', afterId: 'c' });
		expectInvert(src, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'a', offset: 1 }, head: { blockId: 'z', offset: 1 } }
		});
		expectInvert(page([para('before', 'xx'), callout('c', [para('a', 'aa')]), para('z', 'zz')]), {
			kind: 'delete-range',
			range: { anchor: { blockId: 'before', offset: 1 }, head: { blockId: 'z', offset: 1 } }
		});
		const fromChrome: Op = {
			kind: 'delete-range',
			range: { anchor: { blockId: 'c', offset: 0 }, head: { blockId: 'z', offset: 1 } }
		};
		expect(
			invert(src, fromChrome)
				.filter((op): op is Extract<Op, { kind: 'insert-block' }> => op.kind === 'insert-block')
				.map((op) => op.block.id)
		).toEqual(['c']);
		expectInvert(src, fromChrome);
		expectInvert(src, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'c', offset: 0 }, head: { blockId: 'z', offset: 0 } }
		});
		expectInvert(
			page([
				{ id: 't', type: 'toggle', open: false, children: [para('a', 'hid'), para('b', 'two')] },
				para('z', 'zz')
			]),
			{
				kind: 'delete-range',
				range: { anchor: { blockId: 't', offset: 0 }, head: { blockId: 'z', offset: 1 } }
			}
		);
	});

	it('round-trips table row/column insert and delete and cell delete-range', () => {
		function cell(id: string, text: string): Block {
			return { id, type: 'table_cell', content: [span(text)] };
		}
		function row(id: string, cells: Block[]): Block {
			return { id, type: 'table_row', children: cells as Extract<Block, { type: 'table_cell' }>[] };
		}
		function table(id: string, rows: Block[]): Block {
			return { id, type: 'table', children: rows as Extract<Block, { type: 'table_row' }>[] };
		}
		const src = page([
			table('t', [
				row('r1', [cell('c11', 'aa'), cell('c12', 'bb')]),
				row('r2', [cell('c21', 'cc'), cell('c22', 'dd')])
			]),
			para('z', 'zz')
		]);
		expectInvert(src, { kind: 'insert-text', at: { blockId: 'c11', offset: 1 }, text: 'X' });
		expectInvert(src, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'c11', offset: 1 }, head: { blockId: 'c22', offset: 1 } }
		});
		expectInvert(src, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'c22', offset: 1 }, head: { blockId: 'z', offset: 1 } }
		});
		expectInvert(src, { kind: 'delete-block', id: 't' });
		expectInvert(src, {
			kind: 'insert-table-row',
			tableId: 't',
			afterId: 'r1',
			row: row('rN', [cell('n1', 'x'), cell('n2', 'y')]) as Extract<Block, { type: 'table_row' }>
		});
		expectInvert(src, {
			kind: 'insert-table-column',
			tableId: 't',
			index: 1,
			cells: [cell('n1', 'N'), cell('n2', 'M')] as Extract<Block, { type: 'table_cell' }>[]
		});
		expectInvert(src, { kind: 'delete-table-row', tableId: 't', rowId: 'r2' });
		expectInvert(src, { kind: 'delete-table-column', tableId: 't', index: 1 });
		expectInvert(src, {
			kind: 'format-range',
			range: { anchor: { blockId: 'c11', offset: 0 }, head: { blockId: 'c12', offset: 2 } },
			mark: { type: 'bold' },
			on: true
		});
	});

	it('round-trips set-toggle', () => {
		const src = page([
			{
				id: 't',
				type: 'toggle',
				open: true,
				children: [para('a', 'hid')]
			},
			para('z', 'z')
		]);
		expectInvert(src, { kind: 'set-toggle', id: 't', open: false });
		expectInvert(src, { kind: 'set-toggle', id: 't', open: true });
		expect(() => invert(src, { kind: 'set-toggle', id: 'a', open: false })).toThrow(/not a toggle/i);
	});
});
