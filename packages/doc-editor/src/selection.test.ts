import { describe, expect, it } from 'vitest';
import { project } from './project.js';
import {
	focusHeldOutside,
	lineBoxAtY,
	pointFromDom,
	rangeFromEndpoints,
	rangeFromInputEvent,
	restoreSelection,
	caretFromClient,
	emptySpaceCaretFromClient,
	lineStartFromClient,
	trailingLineEndFromClient
} from './selection.js';
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

	it('prefers the live Selection over a stale getTargetRanges()', () => {
		// Regression: after `restoreSelection` moves the caret via
		// `Selection.addRange` (e.g. Enter placing it in a freshly split
		// block), Chrome can report the *next* beforeinput's getTargetRanges()
		// still pointing at the pre-move caret. Trusting that stale range
		// silently redirected typed text into the old block.
		const host = document.createElement('div');
		host.contentEditable = 'true';
		document.body.append(host);
		const doc = page([para('a', 'hello'), para('b', '')]);
		project(host, doc);
		restoreSelection(host, { anchor: { blockId: 'b', offset: 0 }, head: { blockId: 'b', offset: 0 } }, doc);

		const blockA = host.querySelector('[data-block-id="a"]') as HTMLElement;
		const staleTextNode = [...blockA.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		const staleEvent = {
			getTargetRanges: () => [
				{ startContainer: staleTextNode, startOffset: 5, endContainer: staleTextNode, endOffset: 5 }
			]
		} as unknown as InputEvent;

		const fallback = { anchor: { blockId: 'a', offset: 0 }, head: { blockId: 'a', offset: 0 } };
		const live = rangeFromInputEvent(host, staleEvent, fallback);
		expect(live.anchor.blockId).toBe('b');
		expect(live.anchor.offset).toBe(0);
		host.remove();
	});

	it('falls back to getTargetRanges() when no live selection resolves inside host', () => {
		const host = document.createElement('div');
		host.contentEditable = 'true';
		document.body.append(host);
		const doc = page([para('a', 'hello')]);
		project(host, doc);
		document.getSelection()?.removeAllRanges();

		const blockA = host.querySelector('[data-block-id="a"]') as HTMLElement;
		const textNode = [...blockA.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		const event = {
			getTargetRanges: () => [
				{ startContainer: textNode, startOffset: 3, endContainer: textNode, endOffset: 3 }
			]
		} as unknown as InputEvent;

		const fallback = { anchor: { blockId: 'a', offset: 0 }, head: { blockId: 'a', offset: 0 } };
		const result = rangeFromInputEvent(host, event, fallback);
		expect(result.anchor.blockId).toBe('a');
		expect(result.anchor.offset).toBe(3);
		host.remove();
	});
});

/**
 * Repainting must not steal focus from a text field elsewhere in the app —
 * `restoreSelection` focuses the host as a side effect of `addRange`, and the
 * KB tree's inline rename input was losing every edit to it.
 */
describe('focusHeldOutside', () => {
	function withHost(fn: (host: HTMLElement) => void): void {
		const host = document.createElement('div');
		host.contentEditable = 'true';
		document.body.append(host);
		try {
			fn(host);
		} finally {
			host.remove();
		}
	}

	it('is false when nothing outside holds focus', () => {
		withHost((host) => {
			expect(focusHeldOutside(host)).toBe(false);
		});
	});

	it('is false when the focus is inside the host itself', () => {
		withHost((host) => {
			const inner = document.createElement('div');
			inner.tabIndex = 0;
			host.append(inner);
			inner.focus();
			expect(focusHeldOutside(host)).toBe(false);
		});
	});

	it('is true when an input elsewhere holds focus', () => {
		withHost((host) => {
			const input = document.createElement('input');
			document.body.append(input);
			input.focus();
			expect(focusHeldOutside(host)).toBe(true);
			input.remove();
		});
	});

	it('is true when a contenteditable elsewhere holds focus', () => {
		withHost((host) => {
			const other = document.createElement('div');
			// Set through the attribute and make it focusable: jsdom implements
			// neither the `contentEditable` IDL setter nor `isContentEditable`.
			other.setAttribute('contenteditable', 'true');
			other.tabIndex = 0;
			document.body.append(other);
			other.focus();
			expect(document.activeElement).toBe(other);
			expect(focusHeldOutside(host)).toBe(true);
			other.remove();
		});
	});

	it('is false for a button, which is safe to take focus from', () => {
		withHost((host) => {
			const button = document.createElement('button');
			document.body.append(button);
			button.focus();
			expect(focusHeldOutside(host)).toBe(false);
			button.remove();
		});
	});
});

/**
 * Clicking past the last glyph on a line must land at that line's end even
 * when the caret is not already in the block. Native CE only does this for
 * the active block; we hit-test line boxes ourselves.
 */
describe('trailingLineEndFromClient', () => {
	function fakeRect(top: number, height: number, left: number, width: number): DOMRect {
		return {
			x: left,
			y: top,
			top,
			bottom: top + height,
			left,
			right: left + width,
			width,
			height,
			toJSON() {
				return this;
			}
		} as DOMRect;
	}

	it('picks the nearest line by y', () => {
		const a = { top: 10, bottom: 26, left: 8, right: 58, startOffset: 0, endOffset: 5 };
		const b = { top: 30, bottom: 46, left: 8, right: 40, startOffset: 6, endOffset: 9 };
		expect(lineBoxAtY([a, b], 18)?.endOffset).toBe(5);
		expect(lineBoxAtY([a, b], 38)?.endOffset).toBe(9);
	});

	it('snaps a click to the right of an inactive block to that line\'s end', () => {
		const host = document.createElement('div');
		host.contentEditable = 'true';
		document.body.append(host);
		const doc = page([para('a', 'hello'), para('b', 'world')]);
		project(host, doc);
		const blockA = host.querySelector('[data-block-id="a"]') as HTMLElement;
		const blockB = host.querySelector('[data-block-id="b"]') as HTMLElement;
		blockA.getBoundingClientRect = () => fakeRect(10, 16, 8, 400);
		blockB.getBoundingClientRect = () => fakeRect(40, 16, 8, 400);

		const proto = Range.prototype.getClientRects;
		Range.prototype.getClientRects = function () {
			const node = this.startContainer;
			const i = this.startOffset;
			const block = (node as Text).parentElement;
			const top = block === blockB ? 40 : 10;
			const left = 8 + i * 10;
			return [fakeRect(top, 16, left, 10)] as unknown as DOMRectList;
		};
		try {
			expect(trailingLineEndFromClient(host, 200, 48)).toEqual({ blockId: 'b', offset: 5 });
			expect(trailingLineEndFromClient(host, 200, 18)).toEqual({ blockId: 'a', offset: 5 });
			expect(trailingLineEndFromClient(host, 22, 48)).toBeNull();
		} finally {
			Range.prototype.getClientRects = proto;
			host.remove();
		}
	});

	it('snaps to the end of the wrapped line under the pointer, not the whole block', () => {
		const host = document.createElement('div');
		host.contentEditable = 'true';
		document.body.append(host);
		const doc = page([para('p', 'abcdefghij')]);
		project(host, doc);
		const block = host.querySelector('[data-block-id="p"]') as HTMLElement;
		block.getBoundingClientRect = () => fakeRect(10, 40, 8, 400);

		const proto = Range.prototype.getClientRects;
		Range.prototype.getClientRects = function () {
			const i = this.startOffset;
			const top = i < 5 ? 10 : 30;
			const col = i < 5 ? i : i - 5;
			return [fakeRect(top, 16, 8 + col * 10, 10)] as unknown as DOMRectList;
		};
		try {
			expect(trailingLineEndFromClient(host, 200, 18)).toEqual({ blockId: 'p', offset: 5 });
			expect(trailingLineEndFromClient(host, 200, 38)).toEqual({ blockId: 'p', offset: 10 });
		} finally {
			Range.prototype.getClientRects = proto;
			host.remove();
		}
	});

	it('snaps a click to the left of a line to that line\'s start', () => {
		const host = document.createElement('div');
		host.contentEditable = 'true';
		document.body.append(host);
		const doc = page([para('a', 'hello')]);
		project(host, doc);
		const block = host.querySelector('[data-block-id="a"]') as HTMLElement;
		block.getBoundingClientRect = () => fakeRect(10, 16, 0, 400);

		const proto = Range.prototype.getClientRects;
		Range.prototype.getClientRects = function () {
			const i = this.startOffset;
			return [fakeRect(10, 16, 40 + i * 10, 10)] as unknown as DOMRectList;
		};
		try {
			expect(lineStartFromClient(host, 8, 18)).toEqual({ blockId: 'a', offset: 0 });
			expect(emptySpaceCaretFromClient(host, 8, 18)).toEqual({ blockId: 'a', offset: 0 });
			expect(emptySpaceCaretFromClient(host, 200, 18)).toEqual({ blockId: 'a', offset: 5 });
			expect(caretFromClient(host, 200, 18)).toEqual({ blockId: 'a', offset: 5 });
		} finally {
			Range.prototype.getClientRects = proto;
			host.remove();
		}
	});
});
