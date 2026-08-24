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
});
