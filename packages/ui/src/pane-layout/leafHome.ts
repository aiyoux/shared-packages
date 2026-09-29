import { paneLeafSlotId } from './chrome.js';
import type { LayoutNode } from './types.js';

/** Svelte-action return for `homeLeaf`. */
export type HomeLeafAction = {
	update(next: string): void;
	destroy(): void;
};

/**
 * Keying and homing for one PaneLayout instance: the leaf elements it created,
 * which it parks before a split-tree teardown and rehomes into the new slots.
 *
 * The registry is per layout, never shared: a workspace mounts one PaneLayout
 * for the docked window plus one per floater, and a shared map made the next
 * layout to change shape park — and later delete — the other windows' live
 * leaves (the docked Start window's DOM vanished the moment a floater booted).
 * Slots still need no instance namespacing because leaf ids come from one
 * global sequence, so `paneLeafSlotId` is unique document-wide.
 */
export type LeafHome = {
	homeLeaf: (node: HTMLElement, leafId: string) => HomeLeafAction;
	parkLeaves: (park: HTMLElement | null) => void;
	rehomeLeaves: (activeIds?: Iterable<string>) => void;
};

export function createLeafHome(): LeafHome {
	const nodes = new Map<string, HTMLElement>();

	function attach(leafId: string, node: HTMLElement): void {
		if (typeof document === 'undefined') return;
		const slot = document.getElementById(paneLeafSlotId(leafId));
		if (slot && node.parentNode !== slot) slot.appendChild(node);
	}

	/** Svelte action: register a keyed leaf and move it into its layout slot. */
	function homeLeaf(node: HTMLElement, leafId: string): HomeLeafAction {
		nodes.set(leafId, node);
		attach(leafId, node);
		return {
			update(next: string) {
				if (next !== leafId) {
					if (nodes.get(leafId) === node) nodes.delete(leafId);
					leafId = next;
					nodes.set(leafId, node);
				}
				attach(leafId, node);
			},
			destroy() {
				if (nodes.get(leafId) === node) nodes.delete(leafId);
				// The node may have been moved out of the each's park; Svelte's
				// detach then no-ops and would leave a hidden zombie leaf.
				node.remove();
			}
		};
	}

	function parkLeaves(park: HTMLElement | null): void {
		if (!park) return;
		for (const node of nodes.values()) {
			if (node.parentNode !== park) park.appendChild(node);
		}
	}

	function rehomeLeaves(activeIds?: Iterable<string>): void {
		const keep = activeIds ? new Set(activeIds) : null;
		for (const [id, node] of [...nodes]) {
			if (keep && !keep.has(id)) {
				nodes.delete(id);
				node.remove();
				continue;
			}
			attach(id, node);
		}
	}

	return { homeLeaf, parkLeaves, rehomeLeaves };
}

/** Structure of the split tree excluding ratios (resize must not rehome). */
export function layoutSlotKey(node: LayoutNode): string {
	if (node.kind === 'leaf') return `leaf:${node.id}`;
	return `split:${node.id}:${node.direction}(${layoutSlotKey(node.first)},${layoutSlotKey(node.second)})`;
}