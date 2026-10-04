import { afterEach, describe, expect, it, vi } from 'vitest';
import { overlay } from './overlay.ts';
import { anchoredPopup, popupPosition, dismissDetails } from './anchoredPopup.ts';

const actions: { destroy(): void }[] = [];
function mount(html: string) {
	const root = document.createElement('div');
	root.innerHTML = html;
	document.body.append(root);
	return root;
}
function own(node: HTMLElement, options: Parameters<typeof overlay>[1]) {
	const action = overlay(node, options);
	actions.push(action);
	return action;
}
function escape() {
	document.body.dispatchEvent(
		new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
	);
}
afterEach(() => {
	for (const action of actions.reverse()) action.destroy();
	actions.length = 0;
	document.body.replaceChildren();
	document.body.style.overflow = '';
});

describe('shared overlay ownership', () => {
	it('shares ownership when linked packages load through another module graph', async () => {
		const parentClose = vi.fn(), childClose = vi.fn();
		own(mount('<button>Parent</button>'), { kind: 'modal', onClose: parentClose });
		vi.resetModules();
		const second = await import('./overlay.ts');
		const child = second.overlay(mount('<button>Child</button>'), {
			kind: 'popover', onClose: childClose
		});
		actions.push(child);
		escape();
		expect(childClose).toHaveBeenCalledOnce();
		expect(parentClose).not.toHaveBeenCalled();
		child.destroy();
		escape();
		expect(parentClose).toHaveBeenCalledOnce();
	});
	it('lets an inline edit consume Escape before its modal closes', () => {
		const root = mount('<input><button>Close</button>'),
			close = vi.fn();
		own(root, { kind: 'modal', onClose: close });
		root.querySelector('input')!.addEventListener('keydown', (event) => event.preventDefault());
		root
			.querySelector('input')!
			.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
			);
		expect(close).not.toHaveBeenCalled();
		escape();
		expect(close).toHaveBeenCalledOnce();
	});
	it('a popup consumes Escape before an underlying explorer key handler', () => {
		const root = mount('<aside><button>Menu</button></aside>'),
			close = vi.fn(),
			explorer = vi.fn();
		own(root.querySelector('aside')!, { kind: 'popover', onClose: close });
		root.addEventListener('keydown', explorer);
		root
			.querySelector('button')!
			.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
			);
		expect(close).toHaveBeenCalledOnce();
		expect(explorer).not.toHaveBeenCalled();
	});
	it('a popup owns Escape while focus remains on its trigger outside the popup', () => {
		const root = mount('<button>Trigger</button><aside>Menu</aside>');
		const close = vi.fn(), explorer = vi.fn();
		own(root.querySelector('aside')!, {
			kind: 'popover', anchor: () => root.querySelector('button'), onClose: close,
			focusOnOpen: false
		});
		root.addEventListener('keydown', explorer);
		const trigger = root.querySelector('button')!;
		trigger.focus();
		trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		expect(close).toHaveBeenCalledOnce();
		expect(explorer).not.toHaveBeenCalled();
	});
	it('only the nested popup receives Escape, including against legacy window handlers', () => {
		const modal = mount('<button>Parent</button>'),
			popup = mount('<button>Child</button>');
		const parentClose = vi.fn(),
			childClose = vi.fn(),
			legacy = vi.fn();
		own(modal, { kind: 'modal', onClose: parentClose });
		const child = own(popup, { kind: 'popover', onClose: childClose });
		window.addEventListener('keydown', legacy);
		try {
			escape();
			expect(childClose).toHaveBeenCalledOnce();
			expect(parentClose).not.toHaveBeenCalled();
			expect(legacy).not.toHaveBeenCalled();
			child.destroy();
			escape();
			expect(parentClose).toHaveBeenCalledOnce();
		} finally {
			window.removeEventListener('keydown', legacy);
		}
	});
	it('a non-dismissible top dialog shields its parent', () => {
		const parentClose = vi.fn(),
			childClose = vi.fn();
		own(mount('<button>Parent</button>'), { kind: 'modal', onClose: parentClose });
		own(mount('<button>Child</button>'), {
			kind: 'modal',
			onClose: childClose,
			closeOnEscape: false
		});
		escape();
		expect(parentClose).not.toHaveBeenCalled();
		expect(childClose).not.toHaveBeenCalled();
	});
	it('retains nesting when a child mounts before its parent, then portals away', () => {
		const root = mount(
			'<section><button>Parent</button><aside><button>Child</button></aside></section>'
		);
		const parent = root.querySelector('section')!,
			child = root.querySelector('aside')!;
		const parentClose = vi.fn(),
			childClose = vi.fn();
		own(child, { kind: 'modal', onClose: childClose });
		document.body.append(child);
		own(parent, { kind: 'modal', onClose: parentClose });
		escape();
		expect(childClose).toHaveBeenCalledOnce();
		expect(parentClose).not.toHaveBeenCalled();
		expect(Number(child.style.zIndex)).toBeGreaterThan(Number(parent.style.zIndex));
	});
	it('capture outside dismissal survives stopped propagation and interacting with a child keeps its parent', () => {
		const parent = mount('<button>Parent</button>'),
			child = mount('<button>Child</button>'),
			outside = mount('<button>Outside</button>');
		const parentClose = vi.fn(),
			childClose = vi.fn();
		own(parent, { kind: 'popover', onClose: parentClose });
		own(child, { kind: 'popover', onClose: childClose });
		child.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		expect(parentClose).not.toHaveBeenCalled();
		expect(childClose).not.toHaveBeenCalled();
		outside.addEventListener('pointerdown', (event) => event.stopPropagation());
		outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		expect(parentClose).toHaveBeenCalledOnce();
		expect(childClose).toHaveBeenCalledOnce();
	});
	it('clicking the anchor leaves its menu open for the trigger to toggle', () => {
		const root = mount('<button>Trigger</button><aside>Menu</aside>'),
			close = vi.fn();
		own(root.querySelector('aside')!, {
			kind: 'popover',
			anchor: () => root.querySelector('button'),
			onClose: close
		});
		root.querySelector('button')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		expect(close).not.toHaveBeenCalled();
	});
	it('a drag starting in the panel and ending on the scrim does not dismiss', () => {
		const root = mount(
				'<button class="scrim">Scrim</button><section><button>Panel</button></section>'
			),
			close = vi.fn();
		own(root, { kind: 'modal', panel: 'section', onClose: close });
		root.querySelector('section')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		root
			.querySelector('.scrim')!
			.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
		expect(close).not.toHaveBeenCalled();
		root.querySelector('.scrim')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		root
			.querySelector('.scrim')!
			.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
		expect(close).toHaveBeenCalledOnce();
	});
	it('locks scroll through nested dialogs and restores pre-existing overflow/inert state', () => {
		const background = mount('<button>Background</button>'),
			alreadyInert = mount('Inert');
		alreadyInert.inert = true;
		document.body.style.overflow = 'clip';
		const parent = own(mount('<button>Parent</button>'), { kind: 'modal' });
		const child = own(mount('<button>Child</button>'), { kind: 'modal' });
		expect(document.body.style.overflow).toBe('hidden');
		expect(background.inert).toBe(true);
		child.destroy();
		expect(document.body.style.overflow).toBe('hidden');
		parent.destroy();
		expect(document.body.style.overflow).toBe('clip');
		expect(background.inert).toBeFalsy();
		expect(alreadyInert.inert).toBe(true);
	});
	it('focuses, traps Tab and restores focus through a nested modal', async () => {
		const trigger = mount('<button>Trigger</button>').querySelector('button')!;
		trigger.focus();
		const root = mount('<button>First</button><button>Last</button>');
		const action = own(root, { kind: 'modal' });
		await Promise.resolve();
		const [first, last] = root.querySelectorAll('button');
		expect(document.activeElement).toBe(first);
		last.focus();
		last.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
		);
		expect(document.activeElement).toBe(first);
		action.destroy();
		expect(document.activeElement).toBe(trigger);
	});
	it('does not steal focus from editor/terminal controls for a nonmodal popup', async () => {
		const editor = mount('<textarea></textarea>').querySelector('textarea')!;
		editor.focus();
		own(mount('<button>Send key</button>'), {
			kind: 'popover',
			focusOnOpen: false,
			trapFocus: false
		});
		await Promise.resolve();
		expect(document.activeElement).toBe(editor);
	});
	it('details flyouts only take ownership while open', () => {
		const details = mount(
			'<details><summary>Menu</summary><button>Action</button></details>'
		).querySelector('details')!;
		const close = vi.fn();
		const action = dismissDetails(details, close);
		actions.push(action);
		escape();
		expect(close).not.toHaveBeenCalled();
		details.open = true;
		details.dispatchEvent(new Event('toggle'));
		escape();
		expect(close).toHaveBeenCalledOnce();
	});
});

describe('shared anchored placement', () => {
	it('flips a bottom menu above its trigger and clamps an oversized menu inside the viewport', () => {
		const rect = {
			left: 20,
			right: 40,
			top: window.innerHeight - 30,
			bottom: window.innerHeight - 10,
			width: 20,
			height: 20
		} as DOMRect;
		expect(popupPosition(rect, { width: 100, height: 100 } as DOMRect).top).toBe(rect.top - 108);
		const huge = popupPosition(rect, { width: 2000, height: 2000 } as DOMRect);
		expect(huge.top).toBe(12);
		expect(huge.left).toBe(12);
	});
	it('uses native top-layer placement while keeping preview DOM and cleans up', () => {
		const root = mount('<button>Actions</button><aside>Menu</aside>');
		const popup = root.querySelector('aside')!;
		popup.showPopover = vi.fn();
		popup.hidePopover = vi.fn();
		const action = anchoredPopup(popup, { onClose: vi.fn() });
		actions.push(action);
		expect(popup.showPopover).toHaveBeenCalledOnce();
		expect(popup.parentElement).toBe(root);
		expect(popup.style.position).toBe('fixed');
		// jsdom has no :popover-open implementation.
		popup.hidePopover = undefined as unknown as typeof popup.hidePopover;
		action.destroy();
		expect(popup.hasAttribute('popover')).toBe(false);
		expect(popup.hasAttribute('style')).toBe(false);
	});
});
