import { describe, expect, it } from 'vitest';
import {
	createPointerDrag,
	GUARD_SELECTOR,
	insertIndex,
	isInteractiveDragTarget,
	pickZone
} from './tree-dnd.ts';
import {
	flattenVisible,
	isExpandable,
	keyboardTarget,
	type TreeNode
} from './tree-model.ts';

const rect = (height: number, top = 0): DOMRect =>
	({
		top,
		left: 0,
		right: 100,
		bottom: top + height,
		width: 100,
		height,
		x: 0,
		y: top,
		toJSON() {
			return {};
		}
	}) as DOMRect;

describe('insertIndex', () => {
	it('same-list sibling reorder lands before/after the target', () => {
		expect(insertIndex(0, 2, 'before')).toBe(1);
		expect(insertIndex(0, 2, 'after')).toBe(2);
		expect(insertIndex(2, 0, 'before')).toBe(0);
		expect(insertIndex(2, 0, 'after')).toBe(1);
		expect(insertIndex(3, 3, 'before')).toBe(3);
	});
});

describe('pickZone', () => {
	it('top/bottom half for siblings; single allowed zone passes through', () => {
		const r = rect(20);
		expect(pickZone(r, 5, ['before', 'after'])).toBe('before');
		expect(pickZone(r, 15, ['before', 'after'])).toBe('after');
		expect(pickZone(r, 5, ['into'])).toBe('into');
		expect(pickZone(r, 5, [])).toBeNull();
		expect(pickZone(r, 5, ['before', 'after'], { expandedBelow: true })).toBe('after');
		expect(pickZone(r, 5, ['into'], { expandedBelow: true })).toBe('into');
	});

	it('three-zone before/into/after for nestable group headers', () => {
		const r = rect(100);
		const allowed: Array<'before' | 'after' | 'into'> = ['before', 'after', 'into'];
		expect(pickZone(r, 10, allowed)).toBe('before');
		expect(pickZone(r, 50, allowed)).toBe('into');
		expect(pickZone(r, 90, allowed)).toBe('after');
	});
});

describe('isInteractiveDragTarget', () => {
	it('guards data-no-drag and form controls, NOT button rows', () => {
		const make = (html: string) => {
			const el = document.createElement('div');
			el.innerHTML = html;
			return el.firstElementChild as Element;
		};
		expect(isInteractiveDragTarget(make('<button>row</button>'))).toBe(false);
		expect(isInteractiveDragTarget(make('<div data-no-drag></div>'))).toBe(true);
		expect(isInteractiveDragTarget(make('<input />'))).toBe(true);
		expect(isInteractiveDragTarget(make('<div role="checkbox"></div>'))).toBe(true);
		expect(
			isInteractiveDragTarget(make('<div data-no-drag><span>x</span></div>')?.querySelector('span'))
		).toBe(true);
		expect(isInteractiveDragTarget(null)).toBe(false);
		expect(GUARD_SELECTOR).not.toMatch(/\bbutton\b/);
	});
});

describe('flattenVisible + keyboard', () => {
	const tree: TreeNode[] = [
		{
			id: 'p1',
			kind: 'page',
			label: 'Page 1',
			expandable: true,
			children: [
				{
					id: 'l1',
					kind: 'layer',
					label: 'Layer 1',
					expandable: true,
					children: [{ id: 'img1', kind: 'image', label: 'Photo' }]
				},
				{ id: 'l2', kind: 'layer', label: 'Layer 2' }
			]
		},
		{ id: 'p2', kind: 'page', label: 'Page 2' }
	];

	it('hides children of collapsed nodes', () => {
		const collapsed = flattenVisible(tree, []);
		expect(collapsed.map((r) => r.node.id)).toEqual(['p1', 'p2']);
		const openPage = flattenVisible(tree, ['p1']);
		expect(openPage.map((r) => r.node.id)).toEqual(['p1', 'l1', 'l2', 'p2']);
		const openBoth = flattenVisible(tree, ['p1', 'l1']);
		expect(openBoth.map((r) => r.node.id)).toEqual(['p1', 'l1', 'img1', 'l2', 'p2']);
		expect(openBoth.find((r) => r.node.id === 'img1')?.parentId).toBe('l1');
		expect(openBoth.find((r) => r.node.id === 'img1')?.depth).toBe(2);
	});

	it('moves selection and expands/collapses with arrows', () => {
		const expanded = ['p1', 'l1'];
		const rows = flattenVisible(tree, expanded);
		expect(keyboardTarget(rows, 'p1', 'ArrowDown', expanded)?.selectId).toBe('l1');
		expect(keyboardTarget(rows, 'l1', 'ArrowUp', expanded)?.selectId).toBe('p1');
		expect(keyboardTarget(rows, 'img1', 'ArrowLeft', expanded)?.selectId).toBe('l1');
		expect(keyboardTarget(rows, 'l1', 'ArrowLeft', expanded)?.toggleId).toBe('l1');
		expect(keyboardTarget(rows, 'p2', 'ArrowRight', expanded)?.selectId).toBeUndefined();
		expect(isExpandable(tree[0])).toBe(true);
		const collapsedRows = flattenVisible(tree, []);
		expect(keyboardTarget(collapsedRows, 'p1', 'ArrowRight', [])?.toggleId).toBe('p1');
		expect(keyboardTarget(rows, 'img1', 'Enter', expanded)?.activateId).toBe('img1');
	});
});

describe('createPointerDrag', () => {
	it('exposes a rune-free session', () => {
		const session = createPointerDrag({
			dropPolicy: () => ['before', 'after'],
			onCommit: () => {},
			nodeFromEl: () => null
		});
		expect(typeof session.onPointerDown).toBe('function');
		expect(session.didDrag()).toBe(false);
	});

	it('accepts onExternalDrop without changing the session shape', () => {
		const session = createPointerDrag({
			dropPolicy: () => [],
			onCommit: () => {},
			onExternalDrop: () => {},
			nodeFromEl: () => null
		});
		expect(typeof session.onPointerDown).toBe('function');
	});
});
