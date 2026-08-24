import { describe, expect, it } from 'vitest';
import { project } from './project.js';
import { pointFromDom, rangeFromEndpoints, restoreSelection } from './selection.js';
import { page, para } from './testFixtures.js';

describe('selection mapping (cross-block gate)', () => {
	it('maps live endpoints via closest("[data-block-id]") so drag across two paragraphs differs in blockId', () => {
		const host = document.createElement('div');
		document.body.append(host);
		const doc = page([para('a', 'hello'), para('b', 'world')]);
		project(host, doc);
		const blockA = host.querySelector('[data-block-id="a"]') as HTMLElement;
		const blockB = host.querySelector('[data-block-id="b"]') as HTMLElement;
		const tA = [...blockA.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		const tB = [...blockB.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		expect(tA.data).toBe('hello');
		expect(tB.data).toBe('world');

		const range = rangeFromEndpoints(host, tA, 2, tB, 3);
		expect(range).toBeTruthy();
		expect(range!.anchor.blockId).toBe('a');
		expect(range!.head.blockId).toBe('b');
		expect(range!.anchor.blockId !== range!.head.blockId).toBe(true);
		expect(range!.anchor.offset).toBe(2);
		expect(range!.head.offset).toBe(3);

		const fromElement = pointFromDom(host, blockA, 0);
		expect(fromElement).toEqual({ blockId: 'a', offset: 0 });
		const fromElementEnd = pointFromDom(host, blockA, 1);
		expect(fromElementEnd?.blockId).toBe('a');
		expect(fromElementEnd?.offset).toBe(5);
		host.remove();
	});

	it('maps a BR caret to offset 0 or plaintext length', () => {
		const host = document.createElement('div');
		document.body.append(host);
		project(host, page([para('p', 'ab')]));
		const block = host.querySelector('[data-block-id="p"]') as HTMLElement;
		const br = document.createElement('br');
		block.appendChild(br);
		expect(pointFromDom(host, br, 0)?.offset).toBe(2);
		block.insertBefore(br, block.firstChild);
		expect(pointFromDom(host, br, 0)?.offset).toBe(0);
		host.remove();
	});

	it('restores a caret into the empty text node', () => {
		const host = document.createElement('div');
		host.contentEditable = 'true';
		document.body.append(host);
		const doc = page([para('p', '')]);
		project(host, doc);
		restoreSelection(host, { anchor: { blockId: 'p', offset: 0 }, head: { blockId: 'p', offset: 0 } }, doc);
		const sel = document.getSelection();
		expect(sel?.anchorNode?.nodeType).toBe(Node.TEXT_NODE);
		expect(sel?.anchorOffset).toBe(0);
		host.remove();
	});
});
