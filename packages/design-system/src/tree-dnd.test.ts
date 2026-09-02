import { describe, expect, it, vi } from 'vitest';
import {
	applySiblingMove,
	createPointerDrag,
	GUARD_SELECTOR,
	insertIndex,
	isInteractiveDragTarget,
	pickZone,
	rowFromPoint
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

describe('applySiblingMove', () => {
	const list = ['A', 'B', 'C', 'D'];
	it('after: dragged item sits immediately after the target item', () => {
		expect(applySiblingMove(list, 0, 2, 'after')).toEqual(['B', 'C', 'A', 'D']);
		expect(applySiblingMove(list, 3, 1, 'after')).toEqual(['A', 'B', 'D', 'C']);
		expect(applySiblingMove(list, 0, 1, 'after')).toEqual(['B', 'A', 'C', 'D']);
		expect(applySiblingMove(list, 0, 3, 'after')).toEqual(['B', 'C', 'D', 'A']);
	});
	it('before: dragged item sits immediately before the target item', () => {
		expect(applySiblingMove(list, 0, 2, 'before')).toEqual(['B', 'A', 'C', 'D']);
		expect(applySiblingMove(list, 3, 1, 'before')).toEqual(['A', 'D', 'B', 'C']);
		expect(applySiblingMove(list, 3, 0, 'before')).toEqual(['D', 'A', 'B', 'C']);
		expect(applySiblingMove(list, 1, 3, 'before')).toEqual(['A', 'C', 'B', 'D']);
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

describe('rowFromPoint', () => {
	function mountRows() {
		document.body.innerHTML = `
			<div class="tree">
				<div data-tree-row data-tree-id="a" class="dnd-dragging">
					<button data-tree-bar>A</button>
				</div>
				<div data-tree-row data-tree-id="b">
					<button data-tree-bar>B</button>
				</div>
				<div data-tree-row data-tree-id="c">
					<button data-tree-bar>C</button>
				</div>
			</div>
		`;
		const rows = [...document.querySelectorAll<HTMLElement>('[data-tree-row]')];
		rows.forEach((row, i) => {
			const top = i * 26;
			const box = rect(26, top);
			vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(box);
			const bar = row.querySelector<HTMLElement>('[data-tree-bar]')!;
			vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(box);
		});
		return rows;
	}

	function stubHits(nodes: Element[]) {
		document.elementsFromPoint = () => nodes;
	}

	it('skips the dragging source and returns the row under the cursor', () => {
		const rows = mountRows();
		const source = rows[0]!;
		const over = rows[2]!;
		stubHits([over, document.body]);
		const hit = rowFromPoint(10, 60, '[data-tree-row]', { skip: source });
		expect(hit?.dataset.treeId).toBe('c');
	});

	it('does not snap to a neighbour while the cursor is still on the source', () => {
		const rows = mountRows();
		const source = rows[0]!;
		stubHits([source, document.body]);
		const hit = rowFromPoint(10, 10, '[data-tree-row]', { skip: source });
		expect(hit).toBeNull();
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

	it('pointerup over the lower half of a later row commits after, not before', () => {
		document.body.innerHTML = `
			<div class="tree">
				<div data-tree-row data-tree-id="a"><button data-tree-bar>A</button></div>
				<div data-tree-row data-tree-id="b"><button data-tree-bar>B</button></div>
				<div data-tree-row data-tree-id="c"><button data-tree-bar>C</button></div>
			</div>
		`;
		const rows = [...document.querySelectorAll<HTMLElement>('[data-tree-row]')];
		rows.forEach((row, i) => {
			const box = rect(26, i * 26);
			vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(box);
			vi.spyOn(row.querySelector('[data-tree-bar]')!, 'getBoundingClientRect').mockReturnValue(box);
		});

		const committed: Array<{ over: string; zone: string }> = [];
		const session = createPointerDrag({
			dropPolicy: () => ['before', 'after'],
			onCommit: (_drag, over, zone) => committed.push({ over: over.id, zone }),
			nodeFromEl: (el) => ({ kind: 'row', id: el.dataset.treeId ?? '', meta: undefined })
		});

		const sourceBar = rows[0]!.querySelector('button')!;
		sourceBar.addEventListener('pointerdown', (e) =>
			session.onPointerDown(e as PointerEvent, { kind: 'row', id: 'a' })
		);
		sourceBar.dispatchEvent(
			new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 })
		);

		const overC = rows[2]!;
		document.elementsFromPoint = () => [overC, document.body];
		document.dispatchEvent(
			new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 70 })
		);
		document.dispatchEvent(
			new MouseEvent('pointerup', { bubbles: true, clientX: 10, clientY: 70 })
		);

		expect(committed).toEqual([{ over: 'c', zone: 'after' }]);
		expect(overC.querySelector('[data-tree-bar]')?.className).not.toMatch(/dnd-zone-/);
	});
});
