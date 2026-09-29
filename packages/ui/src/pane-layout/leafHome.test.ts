import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLeafHome } from './leafHome.ts';

/**
 * Minimal document for `attach`: slot and park lookups go through
 * `getElementById`, so each fake node tracks its own parent and children.
 */
type FakeNode = {
	parentNode: FakeNode | null;
	children: FakeNode[];
	appendChild(child: FakeNode): FakeNode;
	remove(): void;
};

const slots = new Map<string, FakeNode | null>();

function el(): FakeNode {
	return {
		parentNode: null,
		children: [],
		appendChild(child) {
			detach(child);
			this.children.push(child);
			child.parentNode = this;
			return child;
		},
		remove() {
			if (this.parentNode) {
				const i = this.parentNode.children.indexOf(this);
				if (i >= 0) this.parentNode.children.splice(i, 1);
			}
			this.parentNode = null;
		}
	};
}

function detach(node: FakeNode): void {
	if (!node.parentNode) return;
	const i = node.parentNode.children.indexOf(node);
	if (i >= 0) node.parentNode.children.splice(i, 1);
	node.parentNode = null;
}

describe('createLeafHome', () => {
	beforeEach(() => {
		(globalThis as Record<string, unknown>).document = {
			getElementById: (id: string) => slots.get(id) ?? null
		};
	});
	afterEach(() => {
		delete (globalThis as Record<string, unknown>).document;
		slots.clear();
	});

	it('homes a leaf into its own slot and parks/rehomes it around teardowns', () => {
		slots.set('pl-leaf-slot-a', el());
		const park = el();
		const home = createLeafHome();
		const node = el();
		const action = home.homeLeaf(node, 'a');
		expect(node.parentNode).toBe(slots.get('pl-leaf-slot-a'));

		home.parkLeaves(park);
		expect(node.parentNode).toBe(park);
		home.rehomeLeaves(['a']);
		expect(node.parentNode).toBe(slots.get('pl-leaf-slot-a'));

		action.update('a');
		expect(node.parentNode).toBe(slots.get('pl-leaf-slot-a'));
		action.destroy();
		expect(node.parentNode).toBe(null);
	});

	it('parks only its own leaves — another instance\'s live leaf is untouched', () => {
		// Docked window and floater, each with one leaf, as the hub mounts them.
		slots.set('pl-leaf-slot-a', el());
		slots.set('pl-leaf-slot-b', el());
		const parkA = el();
		const parkB = el();
		const main = createLeafHome();
		const docked = el();
		main.homeLeaf(docked, 'a');

		const floater = createLeafHome();
		const floatLeaf = el();
		floater.homeLeaf(floatLeaf, 'b');

		// The floater's pane changes shape; its pre-effect parks. It must park
		// its own leaf and leave the docked one in its slot.
		floater.parkLeaves(parkB);
		expect(floatLeaf.parentNode).toBe(parkB);
		expect(docked.parentNode).toBe(slots.get('pl-leaf-slot-a'));

		// Rehoming against the floater's own ids must not remove the docked
		// window's leaf from the document.
		floater.rehomeLeaves(['b']);
		expect(floatLeaf.parentNode).toBe(slots.get('pl-leaf-slot-b'));
		expect(docked.parentNode).toBe(slots.get('pl-leaf-slot-a'));
	});

	it('the other instance rehoming later does not steal the first\'s leaf', () => {
		slots.set('pl-leaf-slot-b', el());
		const parkB = el();
		const floater = createLeafHome();
		const floatLeaf = el();
		floater.homeLeaf(floatLeaf, 'b');

		const main = createLeafHome();
		main.parkLeaves(parkB); // main's shape changed while the floater lives
		expect(floatLeaf.parentNode).toBe(slots.get('pl-leaf-slot-b'));

		main.rehomeLeaves();
		expect(floatLeaf.parentNode).toBe(slots.get('pl-leaf-slot-b'));
	});
});