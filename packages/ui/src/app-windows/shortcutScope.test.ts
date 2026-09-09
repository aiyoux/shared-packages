import { describe, expect, it } from 'vitest';
import { appWindowsOwnsShortcut } from './shortcutScope.js';

type Fake = {
	className: string;
	attrs: Record<string, string>;
	parentElement: Fake | null;
	children: Fake[];
	getAttribute(name: string): string | null;
	contains(other: Fake): boolean;
	closest(sel: string): Fake | null;
	append(...kids: Fake[]): void;
};

function matches(node: Fake, sel: string): boolean {
	if (sel === '.aw-host') return node.className.split(/\s+/).includes('aw-host');
	const m = /^\[([^=]+)="([^"]+)"\]$/.exec(sel);
	return Boolean(m && node.getAttribute(m[1]!) === m[2]);
}

function el(attrs: Record<string, string> = {}): Fake {
	const node: Fake = {
		className: attrs.class ?? '',
		attrs,
		parentElement: null,
		children: [],
		getAttribute(name) {
			return this.attrs[name] ?? null;
		},
		contains(other) {
			if (other === this) return true;
			return this.children.some((child) => child.contains(other));
		},
		closest(sel) {
			let cur: Fake | null = this;
			while (cur) {
				if (matches(cur, sel)) return cur;
				cur = cur.parentElement;
			}
			return null;
		},
		append(...kids) {
			for (const kid of kids) {
				kid.parentElement = this;
				this.children.push(kid);
			}
		}
	};
	return node;
}

describe('appWindowsOwnsShortcut', () => {
	it('ignores events when the host is missing', () => {
		expect(appWindowsOwnsShortcut(null, el() as unknown as EventTarget)).toBe(false);
	});

	it('claims events inside its own host', () => {
		const host = el({ class: 'aw-host' });
		const inner = el();
		host.append(inner);
		expect(appWindowsOwnsShortcut(host as unknown as HTMLElement, inner as unknown as EventTarget)).toBe(
			true
		);
	});

	it('does not claim a sibling host in another hub pane', () => {
		const a = el({ 'data-testid': 'pl-leaf', 'data-pl-focused': 'true' });
		const b = el({ 'data-testid': 'pl-leaf', 'data-pl-focused': 'false' });
		const hostA = el({ class: 'aw-host' });
		const hostB = el({ class: 'aw-host' });
		const btnB = el();
		a.append(hostA);
		b.append(hostB);
		hostB.append(btnB);
		expect(appWindowsOwnsShortcut(hostA as unknown as HTMLElement, btnB as unknown as EventTarget)).toBe(
			false
		);
		expect(appWindowsOwnsShortcut(hostB as unknown as HTMLElement, btnB as unknown as EventTarget)).toBe(
			true
		);
	});

	it('with no focused target, only the focused hub pane owns the shortcut', () => {
		const a = el({ 'data-testid': 'pl-leaf', 'data-pl-focused': 'true' });
		const b = el({ 'data-testid': 'pl-leaf', 'data-pl-focused': 'false' });
		const hostA = el({ class: 'aw-host' });
		const hostB = el({ class: 'aw-host' });
		a.append(hostA);
		b.append(hostB);
		expect(appWindowsOwnsShortcut(hostA as unknown as HTMLElement, null)).toBe(true);
		expect(appWindowsOwnsShortcut(hostB as unknown as HTMLElement, null)).toBe(false);
	});

	it('nested AppWindows (library picker) only own events inside themselves', () => {
		const outer = el({ class: 'aw-host' });
		const inner = el({ class: 'aw-host' });
		const btn = el();
		outer.append(inner);
		inner.append(btn);
		expect(appWindowsOwnsShortcut(inner as unknown as HTMLElement, btn as unknown as EventTarget)).toBe(
			true
		);
		expect(appWindowsOwnsShortcut(outer as unknown as HTMLElement, btn as unknown as EventTarget)).toBe(
			false
		);
		expect(appWindowsOwnsShortcut(inner as unknown as HTMLElement, null)).toBe(false);
	});

	it('portaled chrome in this pane belongs to the outer host', () => {
		const leaf = el({ 'data-testid': 'pl-leaf', 'data-pl-focused': 'true' });
		const chrome = el();
		const host = el({ class: 'aw-host' });
		leaf.append(chrome, host);
		expect(appWindowsOwnsShortcut(host as unknown as HTMLElement, chrome as unknown as EventTarget)).toBe(
			true
		);
	});

	it('focused pane owns shortcut when target is outside the leaf (e.g. body)', () => {
		const body = el();
		const a = el({ 'data-testid': 'pl-leaf', 'data-pl-focused': 'true' });
		const b = el({ 'data-testid': 'pl-leaf', 'data-pl-focused': 'false' });
		const hostA = el({ class: 'aw-host' });
		const hostB = el({ class: 'aw-host' });
		a.append(hostA);
		b.append(hostB);
		// body is not inside any pl-leaf — the focused pane should own it
		expect(appWindowsOwnsShortcut(hostA as unknown as HTMLElement, body as unknown as EventTarget)).toBe(
			true
		);
		expect(appWindowsOwnsShortcut(hostB as unknown as HTMLElement, body as unknown as EventTarget)).toBe(
			false
		);
	});
});
