import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it } from 'vitest';
import KbEditor from './KbEditor.svelte';
import { rangeFromSelection } from './selection.js';
import type { Op } from '@shared-packages/kb-model';
import { applyEditorOps, createEditorState } from './state.js';
import { page, para } from './testFixtures.js';

describe('KbEditor mount', () => {
	it('keeps gutter handles outside the host and does not contenteditable per-block descendants', async () => {
		let state = createEditorState(page([para('a', 'hello'), para('b', 'world')]));
		const { container, unmount } = render(KbEditor, {
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
});
