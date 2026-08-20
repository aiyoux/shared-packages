import { paneLeafSlotId } from './chrome.js';
import type { LayoutNode } from './types.js';

const nodes = new Map<string, HTMLElement>();

function attach(leafId: string, node: HTMLElement): void {
	if (typeof document === 'undefined') return;
	const slot = document.getElementById(paneLeafSlotId(leafId));
	if (slot && node.parentNode !== slot) slot.appendChild(node);
}

/** Svelte action: register a keyed leaf and move it into its layout slot. */
export function homeLeaf(node: HTMLElement, leafId: string) {
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

export function parkLeaves(park: HTMLElement | null): void {
	if (!park) return;
	for (const node of nodes.values()) {
		if (node.parentNode !== park) park.appendChild(node);
	}
}

export function rehomeLeaves(activeIds?: Iterable<string>): void {
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

/** Structure of the split tree excluding ratios (resize must not rehome). */
export function layoutSlotKey(node: LayoutNode): string {
	if (node.kind === 'leaf') return `leaf:${node.id}`;
	return `split:${node.id}:${node.direction}(${layoutSlotKey(node.first)},${layoutSlotKey(node.second)})`;
}
