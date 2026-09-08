import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it } from 'vitest';
import DocEditor from './DocEditor.svelte';
import { rangeFromSelection } from './selection.js';
import type { Op } from '@shared-packages/doc-model';
import { applyEditorOps, createEditorState } from './state.js';
import { page, para } from './testFixtures.js';

if (typeof PointerEvent === 'undefined') {
	(globalThis as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = class PointerEvent extends MouseEvent {
		pointerId: number;
		constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
			super(type, init);
			this.pointerId = init.pointerId ?? 0;
		}
	} as unknown as typeof MouseEvent;
}

describe('DocEditor mount', () => {
	it('keeps gutter handles outside the host and does not contenteditable per-block descendants', async () => {
		let state = createEditorState(page([para('a', 'hello'), para('b', 'world')]));
		const { container, unmount } = render(DocEditor, {
			props: {
				state,
				editable: true,
				showHandles: true,
				onDispatch: (op: Op | Op[]) => {
					state = applyEditorOps(state, op);
				}
			}
		});
		await tick();
		const host = container.querySelector('[data-testid="kb-host"]') as HTMLElement;
		const handle = container.querySelector('[aria-label="Drag to reorder"]') as HTMLElement;
		expect(host).toBeTruthy();
		expect(handle).toBeTruthy();
		expect(host.contains(handle)).toBe(false);
		expect(host.querySelectorAll('[contenteditable="true"]').length).toBe(0);
		for (const el of host.querySelectorAll('[data-block-id]')) {
			expect(el.getAttribute('contenteditable')).not.toBe('true');
		}
		expect(host.querySelector('ul')).toBeNull();
		expect(host.querySelector('ol')).toBeNull();

		const blockA = host.querySelector('[data-block-id="a"]') as HTMLElement;
		const blockB = host.querySelector('[data-block-id="b"]') as HTMLElement;
		const tA = [...blockA.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		const tB = [...blockB.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		const sel = document.getSelection()!;
		sel.removeAllRanges();
		const range = document.createRange();
		range.setStart(tA, 1);
		range.setEnd(tB, 2);
		sel.addRange(range);
		const mapped = rangeFromSelection(host, sel);
		expect(mapped).toBeTruthy();
		expect(mapped!.anchor.blockId).toBe('a');
		expect(mapped!.head.blockId).toBe('b');
		expect(mapped!.anchor.blockId !== mapped!.head.blockId).toBe(true);
		unmount();
	});

	it('hides the drag handles by default and shows them on showHandles', async () => {
		let state = createEditorState(page([para('a', 'hello')]));
		const { container, unmount } = render(DocEditor, {
			props: {
				state,
				editable: true,
				onDispatch: (op: Op | Op[]) => {
					state = applyEditorOps(state, op);
				}
			}
		});
		await tick();
		// Default off: the gutter renders (it still carries the indent-guide
		// overlays) but no handle buttons.
		expect(container.querySelector('[data-testid="kb-gutter"]')).toBeTruthy();
		expect(container.querySelector('[aria-label="Drag to reorder"]')).toBeNull();
		// The move-drop line exists but is hidden.
		const dropLine = container.querySelector('.kb-drop-line') as HTMLElement;
		expect(dropLine).toBeTruthy();
		expect(dropLine.hidden).toBe(true);
		unmount();

		const rerender = render(DocEditor, {
			props: {
				state,
				editable: true,
				showHandles: true,
				onDispatch: (op: Op | Op[]) => {
					state = applyEditorOps(state, op);
				}
			}
		});
		await tick();
		expect(rerender.container.querySelector('[aria-label="Drag to reorder"]')).toBeTruthy();
		rerender.unmount();
	});

	function fakeRect(top: number, height: number): DOMRect {
		return {
			x: 0,
			y: top,
			top,
			left: 0,
			bottom: top + height,
			right: 40,
			width: 40,
			height,
			toJSON() {
				return this;
			}
		};
	}

	async function flushLayout(): Promise<void> {
		await tick();
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		await tick();
	}

	it('positions one handle per block after layout, not stacked at the top', async () => {
		let state = createEditorState(page([para('a', '1'), para('b', '2'), para('c', '3')]));
		const proto = HTMLElement.prototype.getBoundingClientRect;
		HTMLElement.prototype.getBoundingClientRect = function () {
			const id = this.getAttribute('data-block-id');
			if (id === 'a') return fakeRect(100, 20);
			if (id === 'b') return fakeRect(128, 20);
			if (id === 'c') return fakeRect(156, 20);
			if (this.getAttribute('data-testid') === 'kb-gutter') return fakeRect(90, 200);
			if (this.getAttribute('data-testid') === 'kb-host') return fakeRect(90, 200);
			return proto.call(this);
		};
		try {
			const { container, unmount } = render(DocEditor, {
				props: {
					state,
					editable: true,
					showHandles: true,
					onDispatch: (op: Op | Op[]) => {
						state = applyEditorOps(state, op);
					}
				}
			});
			await flushLayout();
			const handles = [...container.querySelectorAll('[aria-label="Drag to reorder"]')] as HTMLElement[];
			expect(handles.map((h) => h.getAttribute('data-block-id'))).toEqual(['a', 'b', 'c']);
			expect(handles.map((h) => h.style.top)).toEqual(['10px', '38px', '66px']);
			expect(handles.every((h) => h.style.visibility !== 'hidden')).toBe(true);
			unmount();
		} finally {
			HTMLElement.prototype.getBoundingClientRect = proto;
		}
	});

	it('pointer-dragging a handle dispatches move-block', async () => {
		let state = createEditorState(page([para('a', '1'), para('b', '2'), para('c', '3')]));
		const dispatched: Array<Op | Op[]> = [];
		const proto = HTMLElement.prototype.getBoundingClientRect;
		HTMLElement.prototype.getBoundingClientRect = function () {
			const id = this.getAttribute('data-block-id');
			if (id === 'a') return fakeRect(100, 20);
			if (id === 'b') return fakeRect(128, 20);
			if (id === 'c') return fakeRect(156, 20);
			if (this.getAttribute('data-testid') === 'kb-gutter') return fakeRect(90, 200);
			if (this.getAttribute('data-testid') === 'kb-host') return fakeRect(90, 200);
			return proto.call(this);
		};
		try {
			const { container, unmount } = render(DocEditor, {
				props: {
					state,
					editable: true,
					showHandles: true,
					onDispatch: (op: Op | Op[]) => {
						dispatched.push(op);
						state = applyEditorOps(state, op);
					}
				}
			});
			await flushLayout();
			const handle = container.querySelector('[data-block-id="c"][aria-label="Drag to reorder"]') as HTMLElement;
			expect(handle).toBeTruthy();
			const dropLine = container.querySelector('.kb-drop-line') as HTMLElement;
			expect(dropLine.hidden).toBe(true);
			handle.dispatchEvent(
				new PointerEvent('pointerdown', {
					button: 0,
					clientX: 8,
					clientY: 166,
					pointerId: 1,
					bubbles: true,
					cancelable: true
				})
			);
			document.dispatchEvent(
				new PointerEvent('pointermove', {
					clientX: 8,
					clientY: 105,
					pointerId: 1,
					bubbles: true
				})
			);
			// Mid-drag the landing line paints where the block will go.
			expect(dropLine.hidden).toBe(false);
			document.dispatchEvent(
				new PointerEvent('pointerup', {
					clientX: 8,
					clientY: 105,
					pointerId: 1,
					bubbles: true
				})
			);
			await tick();
			expect(dispatched).toHaveLength(1);
			expect(dispatched[0]).toMatchObject({ kind: 'move-block', id: 'c', afterId: null });
			// The op committed — the indicator must die with the drag, not stay painted.
			expect(dropLine.hidden).toBe(true);
			unmount();
		} finally {
			HTMLElement.prototype.getBoundingClientRect = proto;
		}
	});

	it('renders a hard break as \\n inside the block, with no <br> in the host', async () => {
		let state = createEditorState(page([para('a', 'one\ntwo')]));
		const { container, unmount } = render(DocEditor, {
			props: {
				state,
				editable: true,
				onDispatch: (op: Op | Op[]) => {
					state = applyEditorOps(state, op);
				}
			}
		});
		await tick();
		const host = container.querySelector('[data-testid="kb-host"]') as HTMLElement;
		const block = host.querySelector('[data-block-id="a"]') as HTMLElement;
		expect(block).toBeTruthy();
		// One block, one text node carrying the break; pre-wrap renders it as a new line.
		const text = [...block.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		expect(text?.data).toBe('one\ntwo');
		expect(host.querySelector('br')).toBeNull();
		unmount();
	});
});
