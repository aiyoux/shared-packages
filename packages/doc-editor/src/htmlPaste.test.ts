import { plaintextOf } from '@shared-packages/doc-model';
import { describe, expect, it } from 'vitest';
import { htmlToBlocks } from './htmlPaste.js';
import { pasteOps } from './clipboard.js';
import { createEditorState, dispatchMany } from './state.js';
import { page, para } from './testFixtures.js';

describe('htmlToBlocks', () => {
	it('maps bold, italic, underline, and allowlisted links', () => {
		const blocks = htmlToBlocks(
			'<p>Hello <strong>big</strong> and <em>slant</em> and <u>under</u> and <a href="https://example.com">link</a></p>'
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ type: 'paragraph' });
		if (blocks[0]!.type !== 'paragraph') return;
		const byText = Object.fromEntries(blocks[0].content.map((s) => [s.text, s.marks.map((m) => m.type)]));
		expect(byText.Hello?.length ?? 0).toBe(0);
		expect(byText.big).toEqual(['bold']);
		expect(byText.slant).toEqual(['italic']);
		expect(byText.under).toEqual(['underline']);
		expect(blocks[0].content.find((s) => s.text === 'link')?.marks).toEqual([
			{ type: 'link', href: 'https://example.com' }
		]);
	});

	it('maps CSS text-decoration:underline, but not a link’s own underline', () => {
		const styled = htmlToBlocks('<p><span style="text-decoration:underline">x</span></p>');
		expect(styled[0]!.type).toBe('paragraph');
		if (styled[0]!.type !== 'paragraph') return;
		expect(styled[0].content.find((s) => s.text === 'x')?.marks).toEqual([{ type: 'underline' }]);

		const linked = htmlToBlocks(
			'<p><a href="https://example.com" style="text-decoration:underline">x</a></p>'
		);
		expect(linked[0]!.type).toBe('paragraph');
		if (linked[0]!.type !== 'paragraph') return;
		expect(linked[0].content.find((s) => s.text === 'x')?.marks).toEqual([
			{ type: 'link', href: 'https://example.com' }
		]);
	});

	it('drops javascript: links', () => {
		const blocks = htmlToBlocks('<p><a href="javascript:alert(1)">x</a></p>');
		expect(blocks[0]!.type).toBe('paragraph');
		if (blocks[0]!.type !== 'paragraph') return;
		expect(blocks[0].content[0]?.marks.some((m) => m.type === 'link')).toBe(false);
		expect(plaintextOf(blocks[0])).toBe('x');
	});

	it('maps ul/ol to list_item blocks', () => {
		const bullets = htmlToBlocks('<ul><li>alpha</li><li>beta</li></ul>');
		expect(bullets.map((b) => b.type)).toEqual(['list_item', 'list_item']);
		expect(bullets.every((b) => b.type === 'list_item' && b.ordered === false)).toBe(true);
		expect(bullets.map((b) => plaintextOf(b))).toEqual(['alpha', 'beta']);

		const numbered = htmlToBlocks('<ol><li>one</li><li>two</li></ol>');
		expect(numbered.every((b) => b.type === 'list_item' && b.ordered === true)).toBe(true);
		expect(numbered.map((b) => plaintextOf(b))).toEqual(['one', 'two']);
	});

	it('maps nested ul/ol onto list_item indent', () => {
		const nested = htmlToBlocks('<ul><li>outer<ul><li>inner</li></ul></li></ul>');
		expect(nested.map((b) => plaintextOf(b))).toEqual(['outer', 'inner']);
		expect(nested[0]).not.toHaveProperty('indent');
		expect(nested[1]).toMatchObject({ type: 'list_item', indent: 1, ordered: false });

		const mixed = htmlToBlocks('<ol><li>one<ol><li>nested</li></ol></li><li>two</li></ol>');
		expect(mixed.map((b) => plaintextOf(b))).toEqual(['one', 'nested', 'two']);
		expect(mixed[1]).toMatchObject({ type: 'list_item', indent: 1, ordered: true });
		expect(mixed[2]).not.toHaveProperty('indent');
	});

	it('treats Google Docs ul + list-style-type:decimal as numbered', () => {
		const blocks = htmlToBlocks(
			'<ul><li style="list-style-type:decimal">one</li><li style="list-style-type:decimal">two</li></ul>'
		);
		expect(blocks.every((b) => b.type === 'list_item' && b.ordered === true)).toBe(true);
	});

	it('maps headings h1–h3 and folds h4+ to h3', () => {
		const blocks = htmlToBlocks('<h1>A</h1><h2>B</h2><h4>C</h4>');
		expect(blocks).toEqual([
			expect.objectContaining({ type: 'heading', level: 1 }),
			expect.objectContaining({ type: 'heading', level: 2 }),
			expect.objectContaining({ type: 'heading', level: 3 })
		]);
	});

	it('does not treat Google Docs wrapper <b font-weight:normal> as bold', () => {
		const html =
			'<b style="font-weight:normal;" id="docs-internal-guid-x"><p><span style="font-style:italic">hi</span></p></b>';
		const blocks = htmlToBlocks(html);
		expect(blocks).toHaveLength(1);
		if (blocks[0]!.type !== 'paragraph') return;
		expect(blocks[0].content).toEqual([{ type: 'text', text: 'hi', marks: [{ type: 'italic' }] }]);
	});

	it('maps Word mso-list paragraphs using supportLists markers', () => {
		const html = `
<p class=MsoListParagraph style='mso-list:l0 level1 lfo1'>
<!--[if !supportLists]-->1.<span>&nbsp;&nbsp;</span><!--[endif]-->First
</p>
<p class=MsoListParagraph style='mso-list:l0 level1 lfo1'>
<!--[if !supportLists]-->2.<span>&nbsp;&nbsp;</span><!--[endif]-->Second
</p>
<p class=MsoListParagraph style='mso-list:l1 level1 lfo2'>
<!--[if !supportLists]-->·<span>&nbsp;&nbsp;</span><!--[endif]-->Dot
</p>`;
		const blocks = htmlToBlocks(html);
		expect(blocks.map((b) => b.type)).toEqual(['list_item', 'list_item', 'list_item']);
		expect(blocks[0]).toMatchObject({ type: 'list_item', ordered: true });
		expect(blocks[1]).toMatchObject({ type: 'list_item', ordered: true });
		expect(blocks[2]).toMatchObject({ type: 'list_item', ordered: false });
		expect(blocks.map((b) => plaintextOf(b))).toEqual(['First', 'Second', 'Dot']);
		expect(plaintextOf(blocks[0]!)).not.toMatch(/^1\./);
		expect(blocks[0]).not.toHaveProperty('indent');
	});

	it('maps Word mso-list levelN to indent N-1', () => {
		const html = `
<p class=MsoListParagraph style='mso-list:l0 level1 lfo1'>
<!--[if !supportLists]-->1.<span>&nbsp;&nbsp;</span><!--[endif]-->Outer
</p>
<p class=MsoListParagraph style='mso-list:l0 level2 lfo1'>
<!--[if !supportLists]-->1.<span>&nbsp;&nbsp;</span><!--[endif]-->Inner
</p>
<p class=MsoListParagraph style='mso-list:l0 level1 lfo1'>
<!--[if !supportLists]-->2.<span>&nbsp;&nbsp;</span><!--[endif]-->Back
</p>`;
		const blocks = htmlToBlocks(html);
		expect(blocks.map((b) => plaintextOf(b))).toEqual(['Outer', 'Inner', 'Back']);
		expect(blocks[0]).not.toHaveProperty('indent');
		expect(blocks[1]).toMatchObject({ type: 'list_item', indent: 1, ordered: true });
		expect(blocks[2]).not.toHaveProperty('indent');
	});

	it('skips script tags and empty paragraphs', () => {
		const blocks = htmlToBlocks('<p>keep</p><script>alert(1)</script><p>   </p><p>end</p>');
		expect(blocks.map((b) => plaintextOf(b))).toEqual(['keep', 'end']);
	});

	it('maps a simple HTML table', () => {
		const blocks = htmlToBlocks('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td><i>2</i></td></tr></table>');
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.type).toBe('table');
		if (blocks[0]!.type !== 'table') return;
		expect(blocks[0].children).toHaveLength(2);
		expect(blocks[0].children[0]!.children[0]).toMatchObject({ header: true });
		const italic = blocks[0].children[1]!.children[1]!;
		expect(italic.content.some((s) => s.marks.some((m) => m.type === 'italic') && s.text === '2')).toBe(
			true
		);
	});
});

describe('pasteOps html', () => {
	it('inserts a single formatted paragraph as inlines at the caret', () => {
		const state = createEditorState(page([para('p', 'ab')]));
		const live = { anchor: { blockId: 'p', offset: 1 }, head: { blockId: 'p', offset: 1 } };
		const next = dispatchMany(
			state,
			pasteOps(state, live, { html: '<p><em>X</em></p>', plain: 'X' })
		);
		const block = next.page.blocks[0];
		expect(block.type).toBe('paragraph');
		if (block.type !== 'paragraph') return;
		expect(block.content.map((s) => s.text).join('')).toBe('aXb');
		expect(block.content.find((s) => s.text === 'X')?.marks).toEqual([{ type: 'italic' }]);
	});

	it('inserts a Word-style numbered list as list_item blocks', () => {
		const state = createEditorState(page([para('p', '')]));
		const html = '<ol><li>one</li><li><em>two</em></li></ol>';
		const next = dispatchMany(state, pasteOps(state, state.selection, { html, plain: '1. one\n2. two' }));
		const items = next.page.blocks.filter((b) => b.type === 'list_item');
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({ ordered: true });
		expect(plaintextOf(items[1]!)).toBe('two');
		if (items[1]!.type === 'list_item') {
			expect(items[1].content.some((s) => s.marks.some((m) => m.type === 'italic'))).toBe(true);
		}
	});
});
