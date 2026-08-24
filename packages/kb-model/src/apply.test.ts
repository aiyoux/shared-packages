import { describe, expect, it } from 'vitest';
import { apply, applyMany } from './apply.js';
import { normalizePage } from './normalize.js';
import { plaintext, plaintextOf } from './plaintext.js';
import { blockChildren, findBlock } from './tree.js';
import {
	KB_FORMAT,
	type Block,
	type KbPage,
	type Mark,
	type Op,
	type TextSpan
} from './types.js';
import { hasUnpairedSurrogate } from './utf16.js';

const STAMP = '2026-01-01T00:00:00.000Z';
const EMOJI = 'a👍b';

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
		children: [],
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

function allPayloads(doc: KbPage): string {
	return doc.blocks.map(plaintextOf).join('|');
}

function expectUnpairedFree(doc: KbPage): void {
	for (const block of doc.blocks) {
		expect(hasUnpairedSurrogate(plaintextOf(block))).toBe(false);
	}
}

describe('apply insert-text', () => {
	it('inserts around a👍b at UTF-16 offsets 0,1,3,4 and never splits the pair', () => {
		const base = page([para('p', EMOJI)]);
		expect(plaintextOf(base.blocks[0])).toBe(EMOJI);
		expect(EMOJI.length).toBe(4);

		const at0 = apply(base, { kind: 'insert-text', at: { blockId: 'p', offset: 0 }, text: 'X' });
		expect(plaintextOf(at0.blocks[0])).toBe('Xa👍b');
		const at1 = apply(base, { kind: 'insert-text', at: { blockId: 'p', offset: 1 }, text: 'X' });
		expect(plaintextOf(at1.blocks[0])).toBe('aX👍b');
		const at3 = apply(base, { kind: 'insert-text', at: { blockId: 'p', offset: 3 }, text: 'X' });
		expect(plaintextOf(at3.blocks[0])).toBe('a👍Xb');
		const at4 = apply(base, { kind: 'insert-text', at: { blockId: 'p', offset: 4 }, text: 'X' });
		expect(plaintextOf(at4.blocks[0])).toBe('a👍bX');
		const at2 = apply(base, { kind: 'insert-text', at: { blockId: 'p', offset: 2 }, text: 'X' });
		expect(plaintextOf(at2.blocks[0])).toBe('aX👍b');
		for (const next of [at0, at1, at2, at3, at4]) expectUnpairedFree(next);
	});

	it('throws on insert-text "\\n" into a paragraph and succeeds in code', () => {
		const paraPage = page([para('p', 'ab')]);
		expect(() =>
			apply(paraPage, { kind: 'insert-text', at: { blockId: 'p', offset: 1 }, text: '\n' })
		).toThrow(/newline/i);

		const codePage = page([code('c', 'ab')]);
		const next = apply(codePage, { kind: 'insert-text', at: { blockId: 'c', offset: 1 }, text: '\n' });
		expect(next.blocks[0]).toMatchObject({ type: 'code', text: 'a\nb' });
	});

	it('treats empty insert-text as a no-op and does not bump updatedAt', () => {
		const src = page([para('p', 'ab'), { id: 'd', type: 'divider' }]);
		const frozen = structuredClone(src);
		const next = apply(src, { kind: 'insert-text', at: { blockId: 'p', offset: 1 }, text: '' });
		expect(next).toEqual(src);
		expect(src).toEqual(frozen);
		expect(next.updatedAt).toBe(STAMP);
		expect(apply(src, { kind: 'insert-text', at: { blockId: 'd', offset: 0 }, text: '' })).toEqual(src);
	});

	it('throws on empty insert-text at an unresolved Point', () => {
		const src = page([para('p', 'ab'), { id: 'd', type: 'divider' }]);
		expect(() =>
			apply(src, { kind: 'insert-text', at: { blockId: 'missing', offset: 0 }, text: '' })
		).toThrow(/unresolved Point/i);
		expect(() =>
			apply(src, { kind: 'insert-text', at: { blockId: 'p', offset: 3 }, text: '' })
		).toThrow(/unresolved Point/i);
		expect(() =>
			apply(src, { kind: 'insert-text', at: { blockId: 'd', offset: 1 }, text: '' })
		).toThrow(/unresolved Point/i);
	});

	it('throws on atomic insert-text', () => {
		const src = page([{ id: 'd', type: 'divider' }]);
		expect(() =>
			apply(src, { kind: 'insert-text', at: { blockId: 'd', offset: 0 }, text: 'x' })
		).toThrow(/atomic/i);
	});

	it('uses mark affinity: empty unmarked, offset 0 inherits right, offset > 0 at a boundary inherits left', () => {
		const empty = page([para('e', '')]);
		const intoEmpty = apply(empty, { kind: 'insert-text', at: { blockId: 'e', offset: 0 }, text: 'X' });
		expect(intoEmpty.blocks[0]).toMatchObject({
			content: [span('X')]
		});

		const marked = page([
			{
				id: 'p',
				type: 'paragraph',
				content: [span('ab', [{ type: 'bold' }]), span('cd', [{ type: 'italic' }])]
			}
		]);
		const at0 = apply(marked, { kind: 'insert-text', at: { blockId: 'p', offset: 0 }, text: 'X' });
		expect((at0.blocks[0] as { content: TextSpan[] }).content[0]).toEqual(span('Xab', [{ type: 'bold' }]));

		const at2 = apply(marked, { kind: 'insert-text', at: { blockId: 'p', offset: 2 }, text: 'X' });
		expect((at2.blocks[0] as { content: TextSpan[] }).content).toEqual([
			span('abX', [{ type: 'bold' }]),
			span('cd', [{ type: 'italic' }])
		]);

		const at1 = apply(marked, { kind: 'insert-text', at: { blockId: 'p', offset: 1 }, text: 'X' });
		expect((at1.blocks[0] as { content: TextSpan[] }).content[0]).toEqual(span('aXb', [{ type: 'bold' }]));

		const at4 = apply(marked, { kind: 'insert-text', at: { blockId: 'p', offset: 4 }, text: 'X' });
		expect((at4.blocks[0] as { content: TextSpan[] }).content.at(-1)).toEqual(
			span('cdX', [{ type: 'italic' }])
		);
	});
});

describe('apply delete-range', () => {
	it('deletes around a👍b at 0,1,3,4 without unpaired surrogates', () => {
		const base = page([para('p', EMOJI)]);
		const d01 = apply(base, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'p', offset: 0 }, head: { blockId: 'p', offset: 1 } }
		});
		expect(plaintextOf(d01.blocks[0])).toBe('👍b');
		const d13 = apply(base, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 3 } }
		});
		expect(plaintextOf(d13.blocks[0])).toBe('ab');
		const d34 = apply(base, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'p', offset: 3 }, head: { blockId: 'p', offset: 4 } }
		});
		expect(plaintextOf(d34.blocks[0])).toBe('a👍');
		const d04 = apply(base, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'p', offset: 4 }, head: { blockId: 'p', offset: 0 } }
		});
		expect(plaintextOf(d04.blocks[0])).toBe('');
		for (const next of [d01, d13, d34, d04]) expectUnpairedFree(next);
	});

	it('treats empty delete-range as a no-op', () => {
		const src = page([para('p', 'ab'), { id: 'd', type: 'divider' }]);
		expect(
			apply(src, {
				kind: 'delete-range',
				range: { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 1 } }
			})
		).toEqual(src);
		expect(
			apply(src, {
				kind: 'delete-range',
				range: { anchor: { blockId: 'd', offset: 0 }, head: { blockId: 'd', offset: 0 } }
			})
		).toEqual(src);
	});

	it('joins leftovers on cross-block delete and coerces code LF to space into text-like', () => {
		const src = page([para('a', 'hello'), para('b', 'world')]);
		const joined = apply(src, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'a', offset: 3 }, head: { blockId: 'b', offset: 2 } }
		});
		expect(joined.blocks).toHaveLength(1);
		expect(joined.blocks[0].id).toBe('a');
		expect(plaintextOf(joined.blocks[0])).toBe('helrld');

		const mixed = page([para('p', 'ab'), code('c', 'c\nd')]);
		const intoPara = apply(mixed, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'c', offset: 1 } }
		});
		expect(intoPara.blocks).toHaveLength(1);
		expect(intoPara.blocks[0].type).toBe('paragraph');
		expect(plaintextOf(intoPara.blocks[0])).toBe('a d');

		const intoCode = page([code('c', 'ab\n'), para('p', 'cd')]);
		const codeKeep = apply(intoCode, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'c', offset: 1 }, head: { blockId: 'p', offset: 1 } }
		});
		expect(codeKeep.blocks[0]).toMatchObject({ type: 'code', text: 'ad' });
	});

	it('drops fully covered middle blocks and keeps start type', () => {
		const src = page([para('a', 'aa'), { id: 'd', type: 'divider' }, para('c', 'cc')]);
		const next = apply(src, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'a', offset: 1 }, head: { blockId: 'c', offset: 1 } }
		});
		expect(next.blocks.map((b) => b.id)).toEqual(['a']);
		expect(plaintextOf(next.blocks[0])).toBe('ac');
	});
});

describe('apply format-range', () => {
	it('formats a slice of one text-like block', () => {
		const src = page([para('p', 'hello')]);
		const next = apply(src, {
			kind: 'format-range',
			range: { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 4 } },
			mark: { type: 'bold' },
			on: true
		});
		expect((next.blocks[0] as { content: TextSpan[] }).content).toEqual([
			span('h'),
			span('ell', [{ type: 'bold' }]),
			span('o')
		]);
	});

	it('formats across blocks and skips code/divider/image', () => {
		const src = page([
			para('a', 'aa'),
			code('c', 'zz'),
			{ id: 'd', type: 'divider' },
			para('b', 'bb')
		]);
		const next = apply(src, {
			kind: 'format-range',
			range: { anchor: { blockId: 'a', offset: 1 }, head: { blockId: 'b', offset: 1 } },
			mark: { type: 'italic' },
			on: true
		});
		expect((next.blocks[0] as { content: TextSpan[] }).content).toEqual([
			span('a'),
			span('a', [{ type: 'italic' }])
		]);
		expect(next.blocks[1]).toMatchObject({ type: 'code', text: 'zz' });
		expect(next.blocks[2]).toMatchObject({ type: 'divider' });
		expect((next.blocks[3] as { content: TextSpan[] }).content).toEqual([
			span('b', [{ type: 'italic' }]),
			span('b')
		]);
	});

	it('last link href wins on a span', () => {
		const src = page([para('p', 'hello')]);
		const once = apply(src, {
			kind: 'format-range',
			range: { anchor: { blockId: 'p', offset: 0 }, head: { blockId: 'p', offset: 5 } },
			mark: { type: 'link', href: 'https://a.example' },
			on: true
		});
		const twice = apply(once, {
			kind: 'format-range',
			range: { anchor: { blockId: 'p', offset: 0 }, head: { blockId: 'p', offset: 5 } },
			mark: { type: 'link', href: 'https://b.example' },
			on: true
		});
		expect((twice.blocks[0] as { content: TextSpan[] }).content[0].marks).toEqual([
			{ type: 'link', href: 'https://b.example' }
		]);
	});
});

describe('apply split-block', () => {
	it('splits a paragraph', () => {
		const src = page([para('p', 'abcd')]);
		const next = apply(src, { kind: 'split-block', at: { blockId: 'p', offset: 2 }, newId: 'n' });
		expect(next.blocks.map((b) => b.id)).toEqual(['p', 'n']);
		expect(plaintextOf(next.blocks[0])).toBe('ab');
		expect(plaintextOf(next.blocks[1])).toBe('cd');
		expect(next.blocks[1].type).toBe('paragraph');
	});

	it('keeps heading level and list_item ordered', () => {
		const h = page([heading('h', 'Hello', 2)]);
		const hs = apply(h, { kind: 'split-block', at: { blockId: 'h', offset: 2 }, newId: 'n' });
		expect(hs.blocks[0]).toMatchObject({ type: 'heading', level: 2 });
		expect(hs.blocks[1]).toMatchObject({ type: 'heading', level: 2, id: 'n' });
		expect(plaintextOf(hs.blocks[0])).toBe('He');
		expect(plaintextOf(hs.blocks[1])).toBe('llo');

		const li = page([item('l', 'ab', true)]);
		const ls = apply(li, { kind: 'split-block', at: { blockId: 'l', offset: 1 }, newId: 'n' });
		expect(ls.blocks[0]).toMatchObject({ type: 'list_item', ordered: true });
		expect(ls.blocks[1]).toMatchObject({ type: 'list_item', ordered: true });
	});

	it('type-preserves split of an empty list_item (unwrap is convert-block)', () => {
		const src = page([item('l', '', false)]);
		const next = apply(src, { kind: 'split-block', at: { blockId: 'l', offset: 0 }, newId: 'n' });
		expect(next.blocks).toHaveLength(2);
		expect(next.blocks[0]).toMatchObject({ type: 'list_item', ordered: false, id: 'l' });
		expect(next.blocks[1]).toMatchObject({ type: 'list_item', ordered: false, id: 'n' });
	});

	it('splits code only on an empty last line, leaving a paragraph after the fence', () => {
		const src = page([code('c', 'hi\n')]);
		const next = apply(src, { kind: 'split-block', at: { blockId: 'c', offset: 3 }, newId: 'n' });
		expect(next.blocks[0]).toMatchObject({ type: 'code', text: 'hi' });
		expect(next.blocks[1]).toMatchObject({ type: 'paragraph', id: 'n' });
		expect(plaintextOf(next.blocks[1])).toBe('');

		const empty = page([code('c', '')]);
		const splitEmpty = apply(empty, { kind: 'split-block', at: { blockId: 'c', offset: 0 }, newId: 'n' });
		expect(splitEmpty.blocks[0]).toMatchObject({ type: 'code', text: '' });
		expect(splitEmpty.blocks[1].type).toBe('paragraph');
	});

	it('throws on mid-fence code split, existing newId, and atomic split', () => {
		const src = page([code('c', 'abc'), para('p', 'x'), { id: 'd', type: 'divider' }]);
		expect(() =>
			apply(src, { kind: 'split-block', at: { blockId: 'c', offset: 1 }, newId: 'n' })
		).toThrow(/empty last line/i);
		expect(() =>
			apply(src, { kind: 'split-block', at: { blockId: 'c', offset: 3 }, newId: 'n' })
		).toThrow(/empty last line/i);
		expect(() =>
			apply(src, { kind: 'split-block', at: { blockId: 'p', offset: 1 }, newId: 'c' })
		).toThrow(/already exists/i);
		expect(() =>
			apply(src, { kind: 'split-block', at: { blockId: 'd', offset: 0 }, newId: 'n' })
		).toThrow(/atomic/i);
	});
});

describe('apply merge-block', () => {
	it('merges adjacent blocks only', () => {
		const src = page([para('a', 'he'), para('b', 'llo'), para('c', '!')]);
		const next = apply(src, { kind: 'merge-block', keepId: 'a', dropId: 'b' });
		expect(allPayloads(next)).toBe('hello|!');
		expect(() => apply(src, { kind: 'merge-block', keepId: 'a', dropId: 'c' })).toThrow(/immediate next/i);
		expect(() => apply(src, { kind: 'merge-block', keepId: 'a', dropId: 'a' })).toThrow();
		expect(() => apply(src, { kind: 'merge-block', keepId: 'missing', dropId: 'b' })).toThrow(/unknown/i);
	});

	it('applies the type-coercion table', () => {
		expect(
			plaintextOf(
				apply(page([para('a', 'a'), para('b', 'b')]), { kind: 'merge-block', keepId: 'a', dropId: 'b' })
					.blocks[0]
			)
		).toBe('ab');

		const codeKeep = apply(page([code('a', 'pre'), para('b', 'post')]), {
			kind: 'merge-block',
			keepId: 'a',
			dropId: 'b'
		});
		expect(codeKeep.blocks[0]).toMatchObject({ type: 'code', text: 'prepost' });

		const paraKeep = apply(page([para('a', 'pre'), code('b', 'x\ny')]), {
			kind: 'merge-block',
			keepId: 'a',
			dropId: 'b'
		});
		expect(paraKeep.blocks[0].type).toBe('paragraph');
		expect(plaintextOf(paraKeep.blocks[0])).toBe('prex y');

		const dropAtomic = apply(page([para('a', 'x'), { id: 'd', type: 'divider' }]), {
			kind: 'merge-block',
			keepId: 'a',
			dropId: 'd'
		});
		expect(dropAtomic.blocks).toEqual(page([para('a', 'x')]).blocks);

		expect(() =>
			apply(page([{ id: 'd', type: 'divider' }, para('a', 'x')]), {
				kind: 'merge-block',
				keepId: 'd',
				dropId: 'a'
			})
		).toThrow(/atomic/i);
	});
});

describe('apply convert-block', () => {
	it('preserves id and maps the convert table', () => {
		const src = page([para('p', 'Hello')]);
		const toH = apply(src, { kind: 'convert-block', id: 'p', to: 'heading', level: 2 });
		expect(toH.blocks[0]).toMatchObject({ id: 'p', type: 'heading', level: 2 });
		expect(plaintextOf(toH.blocks[0])).toBe('Hello');

		const toList = apply(src, { kind: 'convert-block', id: 'p', to: 'list_item' });
		expect(toList.blocks[0]).toMatchObject({ id: 'p', type: 'list_item', ordered: false });

		const unwrap = apply(page([item('l', 'x', true)]), { kind: 'convert-block', id: 'l', to: 'paragraph' });
		expect(unwrap.blocks[0]).toEqual(para('l', 'x'));

		const toCode = apply(src, { kind: 'convert-block', id: 'p', to: 'code' });
		expect(toCode.blocks[0]).toMatchObject({ id: 'p', type: 'code', language: '', text: 'Hello' });
	});

	it('turns code LF into spaces when converting to a text-like block', () => {
		const src = page([code('c', 'a\nb\nc', 'ts')]);
		const next = apply(src, { kind: 'convert-block', id: 'c', to: 'paragraph' });
		expect(next.blocks[0].id).toBe('c');
		expect(plaintextOf(next.blocks[0])).toBe('a b c');
	});

	it('throws on convert-to-image', () => {
		const src = page([para('p', 'x'), { id: 'd', type: 'divider' }]);
		expect(() => apply(src, { kind: 'convert-block', id: 'p', to: 'image' })).toThrow(/image/i);
		expect(() => apply(src, { kind: 'convert-block', id: 'd', to: 'image' })).toThrow(/image/i);
	});

	it('does not change Block.id when converting the sole block', () => {
		const src = page([para('only', 'Hi')]);
		for (const to of ['heading', 'list_item', 'code', 'divider'] as const) {
			const next = apply(src, { kind: 'convert-block', id: 'only', to });
			expect(next.blocks).toHaveLength(1);
			expect(next.blocks[0].id).toBe('only');
		}
	});
});

describe('apply other ops and errors', () => {
	it('throws on an illegal Point', () => {
		const src = page([para('p', 'ab'), { id: 'd', type: 'divider' }]);
		expect(() =>
			apply(src, { kind: 'insert-text', at: { blockId: 'missing', offset: 0 }, text: 'x' })
		).toThrow(/unresolved Point/i);
		expect(() =>
			apply(src, { kind: 'insert-text', at: { blockId: 'p', offset: 3 }, text: 'x' })
		).toThrow(/unresolved Point/i);
		expect(() =>
			apply(src, { kind: 'insert-text', at: { blockId: 'p', offset: -1 }, text: 'x' })
		).toThrow(/unresolved Point/i);
		expect(() =>
			apply(src, {
				kind: 'delete-range',
				range: { anchor: { blockId: 'd', offset: 1 }, head: { blockId: 'd', offset: 1 } }
			})
		).toThrow(/unresolved Point/i);
	});

	it('set-children replaces the array', () => {
		const src = page([para('p', 'x')], { children: ['old'] });
		const next = apply(src, { kind: 'set-children', children: ['a', 'b'] });
		expect(next.children).toEqual(['a', 'b']);
		expect(next.updatedAt).toBe(STAMP);
	});

	it('insert-block null prepends; duplicate id throws; delete-block keeps ≥1 block', () => {
		const src = page([para('p', 'x')]);
		const prepended = apply(src, {
			kind: 'insert-block',
			afterId: null,
			block: para('n', 'y')
		});
		expect(prepended.blocks.map((b) => b.id)).toEqual(['n', 'p']);

		expect(() => apply(src, { kind: 'insert-block', afterId: null, block: para('p', 'z') })).toThrow(
			/duplicate/i
		);

		const deleted = apply(src, { kind: 'delete-block', id: 'p' });
		expect(deleted.blocks).toHaveLength(1);
		expect(deleted.blocks[0].type).toBe('paragraph');
		expect(deleted.blocks[0].id).not.toBe('p');
	});

	it('move-block afterId === id throws; set-code is language-only', () => {
		const src = page([para('a', 'a'), code('c', 'x', 'js'), para('b', 'b')]);
		expect(() => apply(src, { kind: 'move-block', id: 'a', afterId: 'a' })).toThrow(/itself/i);
		const moved = apply(src, { kind: 'move-block', id: 'c', afterId: null });
		expect(moved.blocks.map((b) => b.id)).toEqual(['c', 'a', 'b']);
		const lang = apply(src, { kind: 'set-code', id: 'c', language: 'ts' });
		expect(lang.blocks[1]).toMatchObject({ type: 'code', language: 'ts', text: 'x' });
		expect(() => apply(src, { kind: 'set-code', id: 'a', language: 'ts' })).toThrow(/not code/i);
	});

	it('set-title does not bump updatedAt and applyMany composes', () => {
		const src = page([para('p', '')]);
		const next = applyMany(src, [
			{ kind: 'set-title', title: 'New' },
			{ kind: 'insert-text', at: { blockId: 'p', offset: 0 }, text: 'Hi' }
		]);
		expect(next.title).toBe('New');
		expect(plaintextOf(next.blocks[0])).toBe('Hi');
		expect(next.updatedAt).toBe(STAMP);
	});

	it('plaintext concatenates blocks and keeps code newlines', () => {
		const src = page([para('a', 'hi'), code('c', 'a\nb')]);
		expect(plaintext(src)).toBe('hi\na\nb');
	});
});

function callout(id: string, kids: Block[], variant: 'info' | 'warning' | 'note' = 'info'): Block {
	return { id, type: 'callout', variant, children: kids };
}

function toggle(id: string, kids: Block[], open = true): Block {
	return { id, type: 'toggle', open, children: kids };
}

describe('N1 callout/toggle apply', () => {
	it('inserts inside a callout via parentId and stamps schema 2 only on serialize', () => {
		const src = page([callout('c', [para('a', 'a')]), para('z', 'z')]);
		expect(src.schemaVersion).toBe(1);
		const inserted = apply(src, {
			kind: 'insert-block',
			afterId: 'a',
			parentId: 'c',
			block: para('n', 'n')
		});
		expect(inserted.blocks.map((b) => b.id)).toEqual(['c', 'z']);
		expect(findKids(inserted, 'c').map((b) => b.id)).toEqual(['a', 'n']);
		expect(inserted.schemaVersion).toBe(1);
	});

	it('honors the insert-block parentId / afterId truth table', () => {
		const src = page([callout('c', [para('a', 'a'), para('b', 'b')]), para('z', 'z')]);

		expect(apply(src, { kind: 'insert-block', afterId: null, block: para('n', 'n') }).blocks.map((b) => b.id)).toEqual([
			'n',
			'c',
			'z'
		]);
		expect(
			apply(src, { kind: 'insert-block', afterId: 'c', block: para('n', 'n') }).blocks.map((b) => b.id)
		).toEqual(['c', 'n', 'z']);
		expect(() => apply(src, { kind: 'insert-block', afterId: 'a', block: para('n', 'n') })).toThrow(
			/not a child of the page/i
		);

		const prepended = apply(src, {
			kind: 'insert-block',
			afterId: null,
			parentId: 'c',
			block: para('n', 'n')
		});
		expect(findKids(prepended, 'c').map((b) => b.id)).toEqual(['n', 'a', 'b']);

		const afterChild = apply(src, {
			kind: 'insert-block',
			afterId: 'a',
			parentId: 'c',
			block: para('n', 'n')
		});
		expect(findKids(afterChild, 'c').map((b) => b.id)).toEqual(['a', 'n', 'b']);

		expect(() =>
			apply(src, { kind: 'insert-block', afterId: 'z', parentId: 'c', block: para('n', 'n') })
		).toThrow(/not a direct child of parentId/i);
		expect(() =>
			apply(src, { kind: 'insert-block', afterId: null, parentId: 'a', block: para('n', 'n') })
		).toThrow(/callout or toggle/i);
	});

	it('split stays in the parent; merge only same-parent; unique ids are tree-wide', () => {
		const src = page([callout('c', [para('a', 'ab'), para('b', 'cd')]), para('z', 'z')]);
		const split = apply(src, { kind: 'split-block', at: { blockId: 'a', offset: 1 }, newId: 'n' });
		expect(split.blocks.map((b) => b.id)).toEqual(['c', 'z']);
		expect(findKids(split, 'c').map((b) => b.id)).toEqual(['a', 'n', 'b']);

		const merged = apply(src, { kind: 'merge-block', keepId: 'a', dropId: 'b' });
		expect(findKids(merged, 'c').map((b) => b.id)).toEqual(['a']);
		expect(plaintextOf(findBlock(merged, 'a')!)).toBe('abcd');
		expect(() => apply(src, { kind: 'merge-block', keepId: 'a', dropId: 'z' })).toThrow(/immediate next/i);
		expect(() => apply(src, { kind: 'merge-block', keepId: 'c', dropId: 'z' })).toThrow(/atomic/i);

		expect(() =>
			apply(src, { kind: 'insert-block', afterId: 'z', block: para('a', 'dup') })
		).toThrow(/duplicate/i);
		expect(() =>
			apply(src, { kind: 'split-block', at: { blockId: 'z', offset: 0 }, newId: 'a' })
		).toThrow(/already exists/i);
		expect(() =>
			apply(src, { kind: 'insert-block', afterId: 'z', block: callout('n', [para('b', 'dup')]) })
		).toThrow(/duplicate/i);
	});

	it('delete-range from inside a callout to after drops covered siblings and does not concat', () => {
		const src = page([para('before', 'xx'), callout('c', [para('a', 'aa'), para('b', 'bb')]), para('z', 'zz')]);
		const crossed = apply(src, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'a', offset: 1 }, head: { blockId: 'z', offset: 1 } }
		});
		expect(crossed.blocks.map((b) => b.id)).toEqual(['before', 'c', 'z']);
		expect(findKids(crossed, 'c').map((b) => b.id)).toEqual(['a']);
		expect(plaintextOf(findBlock(crossed, 'a')!)).toBe('a');
		expect(plaintextOf(findBlock(crossed, 'z')!)).toBe('z');
		expect(plaintextOf(findBlock(crossed, 'before')!)).toBe('xx');

		const covering = apply(src, {
			kind: 'delete-range',
			range: { anchor: { blockId: 'before', offset: 1 }, head: { blockId: 'z', offset: 1 } }
		});
		expect(covering.blocks.map((b) => b.id)).toEqual(['before']);
		expect(plaintextOf(findBlock(covering, 'before')!)).toBe('xz');
		expect(findBlock(covering, 'c')).toBeUndefined();
	});

	it('moves into and out of a callout and throws on move into a descendant', () => {
		const src = page([callout('c', [para('a', 'a'), para('b', 'b')]), para('z', 'z')]);
		const into = apply(src, { kind: 'move-block', id: 'z', afterId: 'a', parentId: 'c' });
		expect(into.blocks.map((b) => b.id)).toEqual(['c']);
		expect(findKids(into, 'c').map((b) => b.id)).toEqual(['a', 'z', 'b']);

		const out = apply(src, { kind: 'move-block', id: 'b', afterId: 'c' });
		expect(out.blocks.map((b) => b.id)).toEqual(['c', 'b', 'z']);
		expect(findKids(out, 'c').map((b) => b.id)).toEqual(['a']);

		expect(() => apply(src, { kind: 'move-block', id: 'c', afterId: 'a', parentId: 'c' })).toThrow(
			/into itself/i
		);
		expect(() => apply(src, { kind: 'move-block', id: 'c', parentId: 'a', afterId: null })).toThrow(
			/descendant|callout or toggle/i
		);
		expect(() => apply(src, { kind: 'move-block', id: 'c', afterId: 'a' })).toThrow(/descendant/i);
	});

	it('rejects nested callout insert, convert-to-container, and set-toggle on a non-toggle', () => {
		const src = page([callout('c', [para('a', 'a')]), para('z', 'z')]);
		expect(() =>
			apply(src, { kind: 'insert-block', afterId: 'a', parentId: 'c', block: callout('n', [para('x', 'x')]) })
		).toThrow(/nested containers/i);
		expect(() =>
			apply(src, {
				kind: 'insert-block',
				afterId: 'z',
				block: callout('n', [callout('inner', [para('x', 'x')])])
			})
		).toThrow(/nested containers/i);
		expect(() => apply(src, { kind: 'convert-block', id: 'z', to: 'callout' })).toThrow(/callout/i);
		expect(() => apply(src, { kind: 'convert-block', id: 'z', to: 'toggle' })).toThrow(/toggle/i);
		expect(() => apply(src, { kind: 'convert-block', id: 'c', to: 'paragraph' })).toThrow(/callout/i);
		expect(() => apply(src, { kind: 'split-block', at: { blockId: 'c', offset: 0 }, newId: 'n' })).toThrow(
			/atomic/i
		);
		expect(() =>
			apply(src, { kind: 'insert-text', at: { blockId: 'c', offset: 0 }, text: 'x' })
		).toThrow(/atomic/i);
		expect(() => apply(src, { kind: 'set-toggle', id: 'c', open: false })).toThrow(/not a toggle/i);

		const withToggle = page([toggle('t', [para('a', 'a')], true)]);
		const closed = apply(withToggle, { kind: 'set-toggle', id: 't', open: false });
		expect(closed.blocks[0]).toMatchObject({ type: 'toggle', open: false });
	});
});

function findKids(doc: KbPage, id: string): Block[] {
	return blockChildren(findBlock(doc, id)!) ?? [];
}
