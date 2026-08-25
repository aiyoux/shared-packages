/**
 * Drop zone detection + resolve (before / into / after).
 *
 * Ordered lists (supportsSiblingOrder): files split 50/50 before/after so there
 * is no "into file" dead zone; folders keep a middle into-band. Adjacent
 * "after row i" / "before row i+1" collapse to one gap via
 * {@link canonicalizeSiblingZone}.
 *
 * Unordered / legacy (no opts): top 25% before, bottom 25% after, middle into.
 */

export type DropZone = 'before' | 'after' | 'into';

export type DropTarget = {
	id: string;
	parentId: string | null;
	kind: 'folder' | 'file';
};

export type ResolveDropInput = {
	dragIds: string[];
	target: DropTarget;
	zone: DropZone | null;
	/** When false, before/after resolve to null (remote into-only policy). */
	supportsSiblingOrder: boolean;
	/** Optional: ids of descendants of each drag (for cycle check). Key = dragId */
	descendantIds?: Map<string, Set<string>>;
};

export type ResolvedDrop =
	| {
			ok: true;
			/** New parent for the drag item(s) */
			newParentId: string | null;
			/** Same-parent reorder anchors (null = use end/start) */
			beforeId: string | null;
			afterId: string | null;
			/** True if parent changes */
			reparent: boolean;
			mode: 'reorder' | 'move-into';
	  }
	| { ok: false; reason: 'null-zone' | 'cycle' | 'unsupported-zone' | 'invalid-target' };

export type ZoneFromYOpts = {
	kind?: 'file' | 'folder';
	supportsSiblingOrder?: boolean;
};

/**
 * Map pointer Y within a row rect to a drop zone.
 */
export function zoneFromY(
	rect: { top: number; height: number },
	clientY: number,
	opts?: ZoneFromYOpts
): DropZone {
	if (rect.height <= 0) return 'into';
	const y = (clientY - rect.top) / rect.height;
	if (opts?.supportsSiblingOrder) {
		if (opts.kind === 'folder') {
			if (y < 0.25) return 'before';
			if (y > 0.75) return 'after';
			return 'into';
		}
		// Files (and unknown): one in-between gap. Never "into".
		return y < 0.5 ? 'before' : 'after';
	}
	if (y < 0.25) return 'before';
	if (y > 0.75) return 'after';
	return 'into';
}

/**
 * Collapse "before item i" into "after item i-1" so two adjacent rows share a
 * single in-between drop target (no before/after flicker).
 */
export function canonicalizeSiblingZone(
	index: number,
	zone: DropZone
): { index: number; zone: DropZone } {
	if (zone === 'before' && index > 0) return { index: index - 1, zone: 'after' };
	return { index, zone };
}

function isCycle(
	dragIds: string[],
	intoId: string,
	descendantIds?: Map<string, Set<string>>
): boolean {
	for (const id of dragIds) {
		if (id === intoId) return true;
		const desc = descendantIds?.get(id);
		if (desc?.has(intoId)) return true;
	}
	return false;
}

/**
 * Resolve a drop intent into parent + reorder anchors.
 * Null zone never commits (ok:false).
 */
export function resolveDrop(input: ResolveDropInput): ResolvedDrop {
	const { dragIds, target, zone, supportsSiblingOrder, descendantIds } = input;
	if (!zone) return { ok: false, reason: 'null-zone' };
	if (!dragIds.length) return { ok: false, reason: 'invalid-target' };

	// Remote / unordered: only into-folder (or treat before/after as no-op)
	if (!supportsSiblingOrder) {
		if (zone === 'before' || zone === 'after') {
			return { ok: false, reason: 'unsupported-zone' };
		}
		if (target.kind !== 'folder') {
			return { ok: false, reason: 'invalid-target' };
		}
		if (isCycle(dragIds, target.id, descendantIds)) {
			return { ok: false, reason: 'cycle' };
		}
		return {
			ok: true,
			newParentId: target.id,
			beforeId: null,
			afterId: null,
			reparent: true,
			mode: 'move-into'
		};
	}

	if (zone === 'into') {
		if (target.kind !== 'folder') {
			return { ok: false, reason: 'invalid-target' };
		}
		if (isCycle(dragIds, target.id, descendantIds)) {
			return { ok: false, reason: 'cycle' };
		}
		return {
			ok: true,
			newParentId: target.id,
			beforeId: null,
			afterId: null,
			reparent: true,
			mode: 'move-into'
		};
	}

	// before / after → same parent as target, reorder anchors
	const newParentId = target.parentId;
	if (zone === 'before') {
		return {
			ok: true,
			newParentId,
			beforeId: null,
			afterId: target.id,
			reparent: false, // caller compares current parent
			mode: 'reorder'
		};
	}
	// after
	return {
		ok: true,
		newParentId,
		beforeId: target.id,
		afterId: null,
		reparent: false,
		mode: 'reorder'
	};
}
