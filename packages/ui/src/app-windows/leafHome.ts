import type { LayoutNode } from '../pane-layout/types.js';

let instanceSeq = 0;

/** Unique `layoutId` per AppWindows mount. Own counter — must not steal
 *  pane-layout `newLayoutId()`, or the first Files split becomes `leaf-2`
 *  and anything that still names `files-pane-leaf-1` misses. */
export function nextAppWindowLayoutId(base: string): string {
	instanceSeq += 1;
	return `${base}-${instanceSeq}`;
}

export function resetAppWindowLayoutIdsForTests(): void {
	instanceSeq = 0;
}

/** Slot element id. `layoutId` must be unique per AppWindows mount. */
export function appWindowSlotId(layoutId: string, leafId: string): string {
	return `aw-${layoutId}-slot-${leafId}`;
}

/** Body element id. `layoutId` must be unique per AppWindows mount. */
export function appWindowBodyId(layoutId: string, leafId: string): string {
	return `aw-${layoutId}-body-${leafId}`;
}

export function layoutSlotKey(node: LayoutNode): string {
	if (node.kind === 'leaf') return `leaf:${node.id}`;
	return `split:${node.id}:${node.direction}(${layoutSlotKey(node.first)},${layoutSlotKey(node.second)})`;
}

export function createAppWindowLeafHome(layoutId: string) {
	const nodes = new Map<string, HTMLElement>();

	function attach(leafId: string, node: HTMLElement): void {
		if (typeof document === 'undefined') return;
		const slot = document.getElementById(appWindowSlotId(layoutId, leafId));
		if (slot && node.parentNode !== slot) slot.appendChild(node);
	}

	function homeLeaf(node: HTMLElement, leafId: string) {
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
